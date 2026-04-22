/**
 * Epicor tracePacket - XML Method Comparator
 * Reconstrucción desde cero de la lógica
 */

$(function () {

  const STATUS = Object.freeze({
    IGUAL: 'igual',
    DIFERENTE: 'diferente',
    SOBRANTE: 'sobrante',
    FALTANTE: 'faltante'
  });

  const EPICOR_PK_FIELDS = [
    'SysRowID', 'JobNum', 'OrderNum', 'OrderLine', 'OrderRelNum',
    'PONum', 'POLine', 'PORelNum', 'QuoteNum', 'QuoteLine',
    'AssemblySeq', 'OprSeq', 'PartNum', 'CustNum', 'VendorNum',
    'Company',
    // Llaves de almacén/inventario (diferencian registros dentro de PartWhse, PartBin, etc.)
    'WarehouseCode', 'Plant', 'UOMCode', 'BinNum'
  ];

  const BO_IGNORADOS = ['Ice.Proxy.BO.ReportMonitorImpl', 'Ice.Proxy.Lib.BOReaderImpl', 'Ice.Proxy.BO.DocTypeImpl', 'Ice.Proxy.BO.XDocTypeCtrlImpl'];

  // ==========================================
  // XmlParser
  // ==========================================
  const XmlParser = (function () {

    function _buildLineMap(rawStr) {
      // Returns a function: charOffset => lineNumber (1-indexed)
      const offsets = [0]; // offset 0 is line 1
      for (let i = 0; i < rawStr.length; i++) {
        if (rawStr[i] === '\n') offsets.push(i + 1);
      }
      return function (offset) {
        let lo = 0, hi = offsets.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (offsets[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
      };
    }

    function _injectLineAttrs(xmlStr, lineOf) {
      // Inject data-line="N" into every opening tag (not self-closing handled separately)
      // We match every < followed by a letter (not </ <? <!)
      return xmlStr.replace(/<([A-Za-z][^>]*?)(\/?>)/g, function (match, inner, closing, offset) {
        // Avoid double-injecting
        if (inner.indexOf('data-line=') !== -1) return match;
        const ln = lineOf(offset);
        return `<${inner} data-line="${ln}"${closing}`;
      });
    }

    function parsearXML(xmlString) {
      // Remover cabeceras XML que rompan el parsing sin un wrapper global y encerrar todo
      const raw = xmlString.trim().replace(/<\?xml[^?]*\?>/gi, '').trim();

      // Build line-number lookup BEFORE wrapping (the wrapper adds 6 chars `<root>` at offset 0)
      const lineOf = _buildLineMap(raw);
      const withLines = _injectLineAttrs(raw, lineOf);

      const wrapped = `<root>${withLines}</root>`;
      const doc = new DOMParser().parseFromString(wrapped, 'application/xml');

      if (doc.querySelector('parsererror')) {
        throw new Error('El archivo no es un XML válido o su sintaxis está rota.');
      }

      const packets = Array.from(doc.querySelectorAll('tracePacket'));
      if (!packets.length) throw new Error('No se encontraron transacciones <tracePacket>.');

      const ejecuciones = [];
      let idx = 0;
      const countNombres = {};
      let currentBoSeq = 0;
      let lastBoName = null;

      packets.forEach(packet => {
        const metodo = $(packet).find('> methodName').text().trim();
        if (!metodo) return;

        const bo = $(packet).find('> businessObject').text().trim() ||
          $(packet).find('> objectName').text().trim() || '';

        // Ignorar rutinas recurrentes de monitoreo si existen
        if (BO_IGNORADOS.some(b => bo.includes(b) || metodo.includes(b))) return;

        // Numeración cronológica de BOs: detectar cambios de BO
        if (bo !== lastBoName) {
          currentBoSeq++;
          lastBoName = bo;
        }

        idx++;
        countNombres[metodo] = (countNombres[metodo] || 0) + 1;

        ejecuciones.push({
          globalIndex: idx,
          methodIndex: countNombres[metodo],
          boSequence: currentBoSeq,
          boLabel: `[${currentBoSeq}] ${bo}`,
          label: `${metodo} [${countNombres[metodo]}]`,
          metodo: metodo,
          businessObject: bo,
          input: {
            parametros: extraerParametros(packet, 'parameters', 'parameter'),
            datasets: extraerDatasets(packet, 'parameters', 'parameter')
          },
          output: {
            parametros: extraerParametros(packet, 'returnValues', 'returnParameter'),
            datasets: extraerDatasets(packet, 'returnValues', 'returnParameter')
          }
        });
      });

      return ejecuciones;
    }

    function extraerParametros(packet, sectionTag, itemTag) {
      const mapa = new Map();
      const seccion = packet.querySelector(sectionTag);
      if (!seccion) return mapa;

      Array.from(seccion.children).forEach(param => {
        const tag = param.localName || param.nodeName;
        if (!tag.includes(itemTag)) return;

        const nameAttr = $(param).attr('name') || '';
        const typeAttr = $(param).attr('type') || '';
        const lineParam = parseInt(param.getAttribute('data-line') || '0', 10) || null;

        // Función auxiliar recursiva para aplanar nodos
        function _aplanar(node, currentPath) {
          const children = Array.from(node.children).filter(c => c.nodeType === 1);
          if (children.length === 0) {
            // Nodo hoja: guardar valor
            const val = $(node).text().trim();
            const ln = parseInt(node.getAttribute('data-line') || '0', 10) || lineParam;
            mapa.set(currentPath, { name: currentPath, type: typeAttr, value: val, line: ln });
          } else {
            // Nodo con hijos: navegar
            children.forEach(child => {
              let cname = child.localName || child.nodeName;
              if (cname.includes(':')) cname = cname.split(':')[1];
              _aplanar(child, currentPath + ' / ' + cname);
            });
          }
        }

        if (param.children && param.children.length > 0) {
          // Detectar si es un objeto de Contexto o metadatos
          const firstChild = param.children[0];
          let fcName = (firstChild.localName || firstChild.nodeName).split(':')[1] || firstChild.nodeName;

          const esContexto = fcName.includes('Context') ||
            nameAttr.toLowerCase().includes('context') ||
            typeAttr.toLowerCase().includes('context');

          if (esContexto) {
            _aplanar(param, nameAttr || tag);
          }
          // Si es un DataSet de negocio real, NO aplanamos aquí.
          return;
        }

        // Parámetro simple (llave/valor)
        const val = $(param).text().trim();
        if (nameAttr) mapa.set(nameAttr, { name: nameAttr, type: typeAttr, value: val, line: lineParam });
      });
      return mapa;
    }

    function extraerDatasets(packet, sectionTag, itemTag) {
      const datasets = new Map();
      const seccion = packet.querySelector(sectionTag);
      if (!seccion) return datasets;

      Array.from(seccion.children).forEach(param => {
        const tag = param.localName || param.nodeName;
        if (!tag.includes(itemTag)) return;
        if (!param.children || param.children.length === 0) return;

        Array.from(param.children).forEach(dsEl => {
          let dsName = dsEl.localName || dsEl.nodeName;
          if (dsName.includes(':')) dsName = dsName.split(':')[1];
          if (dsName === 'ContextDataSet') return; // Excluir Contexto

          if (!datasets.has(dsName)) datasets.set(dsName, new Map());
          const tblMap = datasets.get(dsName);

          // Algoritmo dinámico para leer filas de tablas saltando wrappers.
          function findTables(node) {
            if (node.nodeType !== 1) return; // Omitir texto

            const children = Array.from(node.children).filter(c => c.nodeType === 1);
            if (children.length === 0) return; // Vacio

            // Determinar si estoy parado en un nodo Fila (sus hijos son hojas = los campos)
            const isRow = children.every(c => Array.from(c.children).filter(cc => cc.nodeType === 1).length === 0);

            if (isRow) {
              let tblName = node.localName || node.nodeName;
              if (tblName.includes(':')) tblName = tblName.split(':')[1];

              if (!tblMap.has(tblName)) tblMap.set(tblName, []);
              const row = {};
              const lineMap = {}; // fieldName -> lineNumber
              children.forEach(field => {
                let fname = field.localName || field.nodeName;
                if (fname.includes(':')) fname = fname.split(':')[1];
                row[fname] = field.textContent || '';
                const ln = parseInt(field.getAttribute('data-line') || '0', 10);
                if (ln) lineMap[fname] = ln;
              });
              if (Object.keys(row).length > 0) {
                row.__lines__ = lineMap; // attach line metadata
                tblMap.get(tblName).push(row);
              }
            } else {
              // Navegar la rama hasta encontrar filas.
              children.forEach(findTables);
            }
          }

          Array.from(dsEl.children).forEach(findTables);
        });
      });
      return datasets;
    }

    function obtenerBOs(ejecuciones) {
      const labels = [];
      const seen = new Set();
      ejecuciones.forEach(e => {
        if (!seen.has(e.boLabel)) {
          seen.add(e.boLabel);
          labels.push(e.boLabel);
        }
      });
      return labels;
    }

    return { parsearXML, obtenerBOs };
  })();

  // ==========================================
  // MotorComparacion
  // ==========================================
  const MotorComparacion = (function () {

    function _normalizar(val, type) {
      if (val === null || val === undefined) return '';
      const str = String(val).trim();
      const t = (type || '').toLowerCase();
      if (t.includes('int') || t.includes('decimal') || t.includes('double') || t.includes('numeric')) {
        const n = parseFloat(str);
        return isNaN(n) ? str : n;
      }
      return str;
    }

    function _sonIguales(valA, typeA, valB, typeB) {
      return _normalizar(valA, typeA) === _normalizar(valB, typeB);
    }

    function buildRecordKey(row) {
      // Campos técnicos que NO deben participar en la clave de negocio,
      // ya que varían entre métodos (GetNew vs Update) y causan falsos SOBRANTE/FALTANTE.
      const TECHNICAL_FIELDS = new Set(['SysRowID', 'SysRevID', 'RowMod', 'BitFlag']);

      // Construir clave COMPUESTA con TODOS los campos de negocio presentes en la fila.
      // Antes se detenía en el primero (ej: Company=PLA01), haciendo que todos los
      // registros de PartWhse colisionaran en el Map y se sobreescribieran.
      const parts = EPICOR_PK_FIELDS
        .filter(pk => !TECHNICAL_FIELDS.has(pk) && row[pk] !== undefined && row[pk] !== null && row[pk] !== '')
        .map(pk => `${pk}=${row[pk]}`);

      if (parts.length > 0) return parts.join('|');

      // Fallback: hash de todos los campos no-técnicos cuando no hay PK de negocio clara
      return Object.entries(row)
        .filter(([k]) => !TECHNICAL_FIELDS.has(k))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
    }

    function compararParametros(mapA, mapB) {
      const resultados = [];
      const keys = new Set([...mapA.keys(), ...mapB.keys()]);

      keys.forEach(k => {
        const a = mapA.get(k);
        const b = mapB.get(k);

        if (a && b) {
          const eq = _sonIguales(a.value, a.type, b.value, b.type);
          resultados.push({
            categoria: 'parametros', name: k,
            valA: a.value, valB: b.value,
            typeA: a.type, typeB: b.type,
            lineA: a.line || null, lineB: b.line || null,
            status: eq ? STATUS.IGUAL : STATUS.DIFERENTE
          });
        } else if (a) {
          resultados.push({
            categoria: 'parametros', name: k,
            valA: a.value, valB: null,
            typeA: a.type, typeB: null,
            lineA: a.line || null, lineB: null,
            status: STATUS.SOBRANTE
          });
        } else {
          resultados.push({
            categoria: 'parametros', name: k,
            valA: null, valB: b.value,
            typeA: null, typeB: b.type,
            lineA: null, lineB: b.line || null,
            status: STATUS.FALTANTE
          });
        }
      });

      return resultados;
    }

    function _aplanarTablas(datasetsMap) {
      const mapa = new Map();
      datasetsMap.forEach((tblMap, dsName) => {
        tblMap.forEach((rows, tblName) => {
          if (!mapa.has(tblName)) mapa.set(tblName, { rows: [], dsName });
          mapa.get(tblName).rows.push(...rows);
        });
      });
      return mapa;
    }

    function compararDatasets(datasetsA, datasetsB) {
      const flatA = _aplanarTablas(datasetsA);
      const flatB = _aplanarTablas(datasetsB);
      const resultados = [];

      // Marcadores Vaciados
      if (flatA.size === 0 && datasetsA.size > 0) {
        datasetsA.forEach((_, dsName) => resultados.push({
          categoria: 'datasets', tblName: '(DataSet Vacío)', dsNameA: dsName, dsNameB: null,
          recordKey: '-', fieldName: 'Info', valA: 'Sin tablas detectadas', valB: null, status: STATUS.IGUAL
        }));
      }
      if (flatB.size === 0 && datasetsB.size > 0) {
        datasetsB.forEach((_, dsName) => resultados.push({
          categoria: 'datasets', tblName: '(DataSet Vacío)', dsNameA: null, dsNameB: dsName,
          recordKey: '-', fieldName: 'Info', valA: null, valB: 'Sin tablas detectadas', status: STATUS.IGUAL
        }));
      }

      const allTbls = new Set([...flatA.keys(), ...flatB.keys()]);

      allTbls.forEach(tblName => {
        const tbA = flatA.get(tblName);
        const tbB = flatB.get(tblName);

        const rowsA = tbA ? tbA.rows : [];
        const rowsB = tbB ? tbB.rows : [];

        if (rowsA.length > 0 && rowsB.length === 0) {
          // Solo A -> Todo SOBRANTE
          rowsA.forEach((rowA, i) => {
            const rKey = rowsA.length === 1 ? tblName : `A[${i}]`;
            const linesA = rowA.__lines__ || {};
            Object.keys(rowA).filter(f => f !== '__lines__').forEach(f => {
              resultados.push({
                categoria: 'datasets', tblName, dsNameA: tbA?.dsName, dsNameB: null,
                recordKey: rKey, fieldName: f, valA: rowA[f], valB: null, status: STATUS.SOBRANTE,
                lineA: linesA[f] || null, lineB: null
              });
            });
          });
        } else if (rowsA.length === 0 && rowsB.length > 0) {
          // Solo B -> Todo FALTANTE
          rowsB.forEach((rowB, j) => {
            const rKey = rowsB.length === 1 ? tblName : `B[${j}]`;
            const linesB = rowB.__lines__ || {};
            Object.keys(rowB).filter(f => f !== '__lines__').forEach(f => {
              resultados.push({
                categoria: 'datasets', tblName, dsNameA: null, dsNameB: tbB?.dsName,
                recordKey: rKey, fieldName: f, valA: null, valB: rowB[f], status: STATUS.FALTANTE,
                lineA: null, lineB: linesB[f] || null
              });
            });
          });
        } else if (rowsA.length > 0 && rowsB.length > 0) {
          const nA = rowsA.length;
          const nB = rowsB.length;

          // Helper: compara un rowA contra un rowB y empuja resultados
          const compararPar = (rowA, rowB, rKey) => {
            const linesA = rowA.__lines__ || {};
            const linesB = rowB.__lines__ || {};
            const fields = new Set([...Object.keys(rowA), ...Object.keys(rowB)].filter(k => k !== '__lines__'));
            fields.forEach(f => {
              const va = rowA[f];
              const vb = rowB[f];
              let st;
              if (va !== undefined && vb !== undefined) {
                st = _sonIguales(va, 'string', vb, 'string') ? STATUS.IGUAL : STATUS.DIFERENTE;
              } else if (va !== undefined) {
                st = STATUS.SOBRANTE;
              } else {
                st = STATUS.FALTANTE;
              }
              resultados.push({
                categoria: 'datasets', tblName, dsNameA: tbA?.dsName, dsNameB: tbB?.dsName,
                recordKey: rKey, fieldName: f, valA: va, valB: vb, status: st,
                lineA: linesA[f] || null, lineB: linesB[f] || null
              });
            });
          };

          if (nA === 1 && nB === 1) {
            // MODO 1: Un solo registro en cada lado → comparación directa plana (sin índices)
            compararPar(rowsA[0], rowsB[0], tblName);

          } else if (nA === nB) {
            // MODO 2: Misma cantidad → emparejamiento 1-a-1 por posición (A[i] ↔ B[i])
            rowsA.forEach((rowA, i) => {
              compararPar(rowA, rowsB[i], `A[${i}] ↔ B[${i}]`);
            });

          } else {
            // MODO 3: Cantidades distintas → Producto Cartesiano (A[i] ↔ B[j])
            rowsA.forEach((rowA, i) => {
              rowsB.forEach((rowB, j) => {
                compararPar(rowA, rowB, `A[${i}] ↔ B[${j}]`);
              });
            });
          }
        }
      });

      return resultados;
    }

    function comparar(da, db, scope) {
      return {
        parametros: (scope === 'parametros' || scope === 'ambos') ? compararParametros(da.parametros, db.parametros) : [],
        datasets: (scope === 'datasets' || scope === 'ambos') ? compararDatasets(da.datasets, db.datasets) : []
      };
    }

    return { comparar };
  })();

  // ==========================================
  // GestorEstado
  // ==========================================
  const GestorEstado = (function () {
    const list = [];
    let idCounter = 0;

    function agregar(item) {
      idCounter++;
      item.id = `comp_${Date.now()}_${idCounter}`;
      item.seqNum = idCounter;
      list.push(item);
      return item;
    }

    function eliminar(id) {
      const i = list.findIndex(e => e.id === id);
      if (i > -1) list.splice(i, 1);
    }

    function vaciar() { list.length = 0; idCounter = 0; }
    function obtenerTodos() { return list; }
    function obtener(id) { return list.find(e => e.id === id); }

    return { agregar, eliminar, vaciar, obtenerTodos, obtener };
  })();

  // ==========================================
  // ControladorUI
  // ==========================================
  const ControladorUI = (function () {
    let _ejecuciones = [];
    let _archivoPendiente = null;

    function _mostrarToast(msg, error = false) {
      const color = error ? 'bg-red-600' : 'bg-green-600';
      const $t = $(`<div class="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-xl text-white text-xs font-bold ${color}">${msg}</div>`).appendTo('body');
      setTimeout(() => $t.fadeOut(300, () => $t.remove()), 3000);
    }

    function _escapar(str) {
      return str == null ? '' : String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function _formatoValor(val) {
      if (val === null || val === undefined) return `<span class="italic text-gray-500/50 text-[10px]">—</span>`;
      if (String(val).trim() === '') return `<span class="italic text-amber-500/80 text-[10px] font-semibold">VACÍO</span>`;
      return `<strong class="font-mono text-[11px] font-normal">${_escapar(val)}</strong>`;
    }

    function _badge(estado) {
      const b = {
        [STATUS.IGUAL]: '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-green-100 text-green-700">IGUAL</span>',
        [STATUS.DIFERENTE]: '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700">DIFERENTE</span>',
        [STATUS.SOBRANTE]: '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-800">SOBRANTE</span>',
        [STATUS.FALTANTE]: '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-orange-100 text-orange-700">FALTANTE</span>'
      };
      return b[estado] || estado;
    }

    function _lnBadge(lineA, lineB) {
      if (!lineA && !lineB) return '<span class="text-[9px] text-gray-300 italic">—</span>';
      const pA = lineA ? `<span class="text-sky-600 font-semibold">${lineA}</span>` : '<span class="text-gray-300">·</span>';
      const pB = lineB ? `<span class="text-violet-600 font-semibold">${lineB}</span>` : '<span class="text-gray-300">·</span>';
      return `<span class="inline-flex flex-col items-center leading-tight text-[8px] text-gray-400 font-mono">
        <span title="Línea en Fuente A">A:${pA}</span>
        <span title="Línea en Fuente B">B:${pB}</span>
      </span>`;
    }

    // Handlers Generales
    $('#dropZone, #fileInput').on('change drop', function (e) {
      e.preventDefault();
      const file = e.type === 'drop' ? e.originalEvent.dataTransfer.files[0] : (e.target.files ? e.target.files[0] : null);
      if (!file) return;

      $('#fileName').text(file.name);

      const reader = new FileReader();
      reader.onload = e => {
        _archivoPendiente = e.target.result;
        _mostrarToast(`Archivo "${file.name}" listo. Presione CARGAR DATA.`);
      };
      reader.readAsText(file, 'UTF-8');
    }).on('dragover', e => e.preventDefault());

    $('#btnCargarXml').on('click', function () {
      if (!_archivoPendiente) {
        return _mostrarToast('Primero seleccione un archivo XML.', true);
      }
      try {
        _ejecuciones = XmlParser.parsearXML(_archivoPendiente);
        _llenarCombos();
        _mostrarToast(`¡Éxito! Se procesaron ${_ejecuciones.length} métodos.`);
      } catch (err) {
        _mostrarToast(err.message, true);
      }
    });

    $('#dropZone').on('click', function (e) {
      if (e.target.id === 'fileInput') return;
      $('#fileInput')[0].click();
    });

    $('#btnRemoveFile').on('click', () => {
      _ejecuciones = [];
      $('#fileName').text('Sin archivo');
      $('#fileInput').val('');
      _archivoPendiente = null;
      GestorEstado.vaciar();
      $('#comparisonsContainer').empty();
      $('#emptyState').show();
      _llenarCombos();
    });

    function _llenarCombos() {
      const bos = XmlParser.obtenerBOs(_ejecuciones);
      ['#selectBusinessObjectA', '#selectBusinessObjectB'].forEach(s => {
        $(s).empty().append('<option value="">— Seleccione BO —</option>');
        bos.forEach(b => $(s).append(`<option value="${b}">${b}</option>`));
        if (bos.length === 1) $(s).val(bos[0]).trigger('change');
      });
    }

    $('#selectBusinessObjectA, #selectBusinessObjectB').on('change', function () {
      const sId = this.id.endsWith('A') ? '#selectMetodoA' : '#selectMetodoB';
      const boLabel = $(this).val();
      $(sId).empty().append('<option value="">— Seleccione Método —</option>');
      _ejecuciones.filter(e => e.boLabel === boLabel || !boLabel).forEach(e => {
        $(sId).append(`<option value="${e.globalIndex}">[${e.globalIndex}] ${e.label}</option>`);
      });
    });

    $('#tipoComparacion').on('change', function () {
      const needsB = $(this).val() === 'output-vs-input';
      $('#selectBusinessObjectB, #selectMetodoB').prop('disabled', !needsB)
        .parent().toggleClass('opacity-40', !needsB);
    });

    $('#btnComparar').on('click', function () {
      if (!_ejecuciones.length) return _mostrarToast('Carga un archivo XML primero.', true);

      const idA = $('#selectMetodoA').val();
      const idB = $('#selectMetodoB').val();
      const tipo = $('#tipoComparacion').val();
      const scope = $('#tipoDatoComparado').val();

      if (tipo !== 'input-vs-output' && tipo !== 'output-vs-input') {
        return _mostrarToast('Modo de comparación no soportado. Abortando.', true);
      }

      if (!idA) return _mostrarToast('Selecciona el Método A', true);
      if (tipo === 'output-vs-input' && !idB) return _mostrarToast('Selecciona el Método B', true);

      const ea = _ejecuciones.find(e => e.globalIndex == idA);
      const eb = tipo === 'output-vs-input' ? _ejecuciones.find(e => e.globalIndex == idB) : ea;

      if (!ea) return _mostrarToast('Error: No se encontró la ejecución seleccionada (A).', true);
      if (tipo === 'output-vs-input' && !eb) return _mostrarToast('Error: No se encontró la ejecución seleccionada (B).', true);

      let dataA, dataB, contexto;
      if (tipo === 'input-vs-output') {
        dataA = ea.input; dataB = ea.output;
        contexto = ea.label; // Ejemplo: ChangeJob [1]
      } else {
        dataA = ea.output; dataB = eb.input;
        contexto = `${ea.label} vs ${eb.label}`; // Ejemplo: Job [1] vs Order [1]
      }

      const resul = MotorComparacion.comparar(dataA, dataB, scope);
      const item = GestorEstado.agregar({
        idEjecucionA: ea.globalIndex,
        idEjecucionB: eb ? eb.globalIndex : null,
        labelA: ea.label,
        labelB: eb ? eb.label : '',
        tipo,
        scope,
        contexto,
        resultados: resul
      });

      _renderTablas(item);
    });

    // Global Expand/Collapse
    $('#btnExpandAll').on('click', function () {
      $('.comparacion-body, .comparacion-subseccion-body').slideDown();
      $('.btnColapsarBloque span, .toggle-icon').text('expand_less');
    });

    $('#btnCollapseAll').on('click', function () {
      $('.comparacion-body, .comparacion-subseccion-body').slideUp();
      $('.btnColapsarBloque span, .toggle-icon').text('expand_more');
    });

    function _renderTablas(item) {
      const tmpl = $('#tmplComparacionBlock')[0].content.cloneNode(true);
      const $b = $(tmpl).find('.comparacion-block');

      $b.attr('data-comparacion-id', item.id);
      $b.find('.comparacion-badge').text('C' + item.seqNum);
      $b.find('.comparacion-contexto').text(item.contexto);
      $b.find('.comparacion-tipo-label').text(item.tipo === 'input-vs-output' ? 'Input A → Output A' : 'Output A → Input B');

      const tbodyP = $b.find('.tbodyParametros');
      const tbodyD = $b.find('.tbodyDatasets');

      if (item.scope !== 'datasets') {
        const cp = { igual: 0, diferente: 0, sobrante: 0, faltante: 0, todos: 0 };
        item.resultados.parametros.forEach(r => {
          cp.todos++;
          if(cp[r.status] !== undefined) cp[r.status]++;
          const lnBadgeP = _lnBadge(r.lineA, r.lineB);
          tbodyP.append(`
            <tr class="border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors data-${r.status}" data-estado="${r.status}">
              <td class="px-6 py-2 pl-10 font-mono text-xs truncate" title="${_escapar(r.name)}">${_escapar(r.name)} <span class="text-[9px] text-gray-500">${r.typeA || r.typeB}</span></td>
              <td class="px-6 py-2 break-all overflow-hidden">${_formatoValor(r.valA)}</td>
              <td class="px-6 py-2 break-all overflow-hidden">${_formatoValor(r.valB)}</td>
              <td class="px-3 py-2 text-center">${lnBadgeP}</td>
              <td class="px-6 py-2">${_badge(r.status)}</td>
            </tr>
          `);
        });

        const selP = $b.find('.filtro-estado[data-seccion="parametros"]');
        selP.find('option[value="todos"]').text(`Todos los estados (${cp.todos})`);
        selP.find('option[value="igual"]').text(`Igual (${cp.igual})`);
        selP.find('option[value="diferente"]').text(`Diferente (${cp.diferente})`);
        selP.find('option[value="sobrante"]').text(`Sobrante (${cp.sobrante})`);
        selP.find('option[value="faltante"]').text(`Faltante (${cp.faltante})`);

        if (!item.resultados.parametros.length) tbodyP.append('<tr><td colspan="5" class="text-center p-4 text-xs italic text-gray-400">Sin parámetros procesados.</td></tr>');
      } else {
        $b.find('.comparacion-seccion-parametros').hide();
      }

      if (item.scope !== 'parametros') {
        const cd = { igual: 0, diferente: 0, sobrante: 0, faltante: 0, todos: 0 };
        const tbm = new Map();
        item.resultados.datasets.forEach(r => {
          if (!['SysRowID', 'RowMod', 'SysRevID'].includes(r.fieldName)) {
            cd.todos++;
            if (cd[r.status] !== undefined) cd[r.status]++;
          }
          if (!tbm.has(r.tblName)) tbm.set(r.tblName, new Map());
          if (!tbm.get(r.tblName).has(r.recordKey)) tbm.get(r.tblName).set(r.recordKey, []);
          tbm.get(r.tblName).get(r.recordKey).push(r);
        });

        const selD = $b.find('.filtro-estado[data-seccion="datasets"]');
        selD.find('option[value="todos"]').text(`Todos los estados (${cd.todos})`);
        selD.find('option[value="igual"]').text(`Igual (${cd.igual})`);
        selD.find('option[value="diferente"]').text(`Diferente (${cd.diferente})`);
        selD.find('option[value="sobrante"]').text(`Sobrante (${cd.sobrante})`);
        selD.find('option[value="faltante"]').text(`Faltante (${cd.faltante})`);

        if (tbm.size === 0) {
          tbodyD.append('<tr><td colspan="5" class="text-center p-4 text-xs italic text-gray-400">Sin DataSets encontrados.</td></tr>');
        } else {
          tbm.forEach((filas, tname) => {
            let dsNameA = null, dsNameB = null;
            // Buscar nombres de DataSet en todos los registros para evitar inconsistencias
            for (const records of filas.values()) {
              const f = records[0];
              if (f.dsNameA) dsNameA = f.dsNameA;
              if (f.dsNameB) dsNameB = f.dsNameB;
              if (dsNameA && dsNameB) break;
            }

            let labelPrefA = item.tipo === 'input-vs-output' ? 'Input A' : 'Output A';
            let labelPrefB = item.tipo === 'input-vs-output' ? 'Output A' : 'Input B';

            const dsA = dsNameA || 'Vacío';
            const dsB = dsNameB || 'Vacío';
            let rootLabel = `${labelPrefA}: ${dsA} | ${labelPrefB}: ${dsB}`;

            const tableIdClass = `trows-${tname.replace(/[^a-zA-Z0-9]/g, '')}-${Math.random().toString(36).substr(2, 5)}`;
            const relLabel = item.tipo === 'input-vs-output' ? 'Input A → Output A' : 'Output A → Input B';
            // Limpiar nombres de métodos para el tag compacto (quitar prefijos redundantes)
            const cleanCtx = item.tipo === 'input-vs-output'
              ? item.labelA
              : `${item.labelA} vs ${item.labelB}`;

            // Generar conteo local excluyendo campos técnicos
            const ct = { igual: 0, diferente: 0, sobrante: 0, faltante: 0, todos: 0 };
            filas.forEach(campos => {
              campos.forEach(c => {
                if (['SysRowID', 'RowMod', 'SysRevID'].includes(c.fieldName)) return;
                ct.todos++;
                if (ct[c.status] !== undefined) ct[c.status]++;
              });
            });

            tbodyD.append(`
              <tr class="bg-surface-container-low border-b border-outline-variant/30 cursor-pointer hover:bg-surface-container transition-colors btnToggleTabla" data-target="${tableIdClass}">
                <td colspan="5" class="px-6 pt-5 pb-3 text-on-surface">
                  <div class="flex flex-col gap-4">
                    <div class="flex items-center gap-2 text-[11px] font-semibold text-primary/80">
                      <span class="material-symbols-outlined text-[15px]">compare_arrows</span> 
                      ${relLabel} : <span class="text-slate-500 font-medium ml-1">${cleanCtx}</span>
                    </div>
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2 text-[14px] font-bold text-primary">
                        <span class="material-symbols-outlined text-[18px] text-secondary">table_chart</span> Tabla: ${tname}
                      </div>
                      <div class="flex items-center gap-3">
                        <select class="filtro-estado-tabla bg-white text-[#334155] border border-[#cbd5e1] rounded pl-2 pr-6 py-0.5 text-[10px] font-bold uppercase cursor-pointer hover:border-secondary outline-none focus:ring-1 focus:ring-secondary/30 transition-colors" data-target="${tableIdClass}">
                          <option value="todos">Todos los estados (${ct.todos})</option>
                          <option value="igual">Igual (${ct.igual})</option>
                          <option value="diferente">Diferente (${ct.diferente})</option>
                          <option value="sobrante">Sobrante (${ct.sobrante})</option>
                          <option value="faltante">Faltante (${ct.faltante})</option>
                        </select>
                        <span class="material-symbols-outlined text-sm text-primary/50 toggle-icon">expand_more</span>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            `);

            const numRegistros = filas.size;

            filas.forEach((campos, rkey) => {
              // 1) Preservamos 100% el orden cronológico original del XML y descartamos cualquier manipulación previa de sort()
              const sorteados = campos;

              const blockId = `block_${Math.random().toString(36).substr(2, 9)}`;

              // ── Separador visual de Registro (solo cuando hay múltiples registros) ──
              if (numRegistros > 1) {
                const todosSob = campos.every(c => c.status === STATUS.SOBRANTE);
                const todosFal = campos.every(c => c.status === STATUS.FALTANTE);
                const rkeyLabel = rkey.replace(/\|/g, ' · ');
                const recBadge = todosSob
                  ? `<span class="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-100 text-amber-700 uppercase">Solo A (Sobrante)</span>`
                  : todosFal
                  ? `<span class="px-1.5 py-0.5 rounded text-[8px] font-bold bg-orange-100 text-orange-700 uppercase">Solo B (Faltante)</span>`
                  : `<span class="px-1.5 py-0.5 rounded text-[8px] font-bold bg-blue-50 text-blue-600 uppercase">Comparando</span>`;

                tbodyD.append(`
                  <tr class="border-t-2 border-slate-200 bg-slate-50 ${tableIdClass} cursor-pointer hover:bg-slate-100 transition-colors btnToggleRecord" data-record-header="true" data-target="${blockId}" style="display:none;">
                    <td colspan="5" class="px-6 py-1 pl-8">
                      <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-[15px] text-slate-500 toggle-icon">expand_more</span>
                        <span class="text-[10px] font-bold font-mono text-slate-700 truncate" title="${_escapar(rkeyLabel)}">${_escapar(rkeyLabel)}</span>
                        ${recBadge}
                      </div>
                    </td>
                  </tr>
                `);
              }

              sorteados.forEach(c => {
                // Filtro de campos técnicos de Epicor
                if (['SysRowID', 'RowMod', 'SysRevID'].includes(c.fieldName)) return;

                const lnBadgeD = _lnBadge(c.lineA, c.lineB);
                tbodyD.append(`
                  <tr class="border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors data-${c.status} ${tableIdClass} ${numRegistros > 1 ? blockId : ''}" data-estado="${c.status}" style="display:none;">
                    <td class="px-6 py-1.5 pl-12 text-[11px] font-mono font-medium truncate" title="${_escapar(c.fieldName)}">${_escapar(c.fieldName)}</td>
                    <td class="px-6 py-1.5 break-all overflow-hidden">${_formatoValor(c.valA)}</td>
                    <td class="px-6 py-1.5 break-all overflow-hidden">${_formatoValor(c.valB)}</td>
                    <td class="px-3 py-1.5 text-center">${lnBadgeD}</td>
                    <td class="px-6 py-1.5">${_badge(c.status)}</td>
                  </tr>
                `);
              });
            });
          });
        }
      } else {
        $b.find('.comparacion-seccion-datasets').hide();
      }

      // Eventos del nuevo bloque inyectado
      $b.find('.btnEliminarBloque').attr('data-id', item.id).on('click', function () {
        GestorEstado.eliminar(item.id);
        $b.slideUp(200, () => {
          $b.remove();
          if (!$('.comparacion-block').length) $('#emptyState').show();
        });
      });

      $b.find('.btnColapsarBloque').on('click', function () {
        const body = $b.find('.comparacion-body');
        const isHidden = body.is(':hidden');
        body.slideToggle();
        $(this).find('span').text(isHidden ? 'expand_less' : 'expand_more');
      });

      $b.find('.btnToggleSubSeccion').on('click', function () {
        const subBody = $(this).next('.comparacion-subseccion-body');
        const isHidden = subBody.is(':hidden');
        subBody.slideToggle();
        $(this).find('.toggle-icon').text(isHidden ? 'expand_less' : 'expand_more');
      });

      // Detener propagación para que el click en el select no cierre el acordeón
      $b.find('.filtro-estado').on('click', function (e) {
        e.stopPropagation();
      });

      $b.find('.btnToggleRecord').on('click', function(e) {
        e.stopPropagation();
        const tgt = $(this).attr('data-target');
        const rows = $b.find(`.${tgt}`);
        const isCollapsed = $(this).data('collapsed');
        
        if (isCollapsed) {
          rows.removeClass('local-collapsed').css('display', 'table-row').hide().fadeIn(200);
          $(this).find('.toggle-icon').text('expand_more');
          $(this).data('collapsed', false);
        } else {
          rows.addClass('local-collapsed').fadeOut(200);
          $(this).find('.toggle-icon').text('chevron_right');
          $(this).data('collapsed', true);
        }
      });

      $b.find('.btnToggleTabla').on('click', function () {
        const tgt = $(this).attr('data-target');
        const rows = $b.find(`.${tgt}`);
        const isHidden = rows.first().is(':hidden');

        if (isHidden) {
          // Al expandir la tabla principal, no mostramos los que fueron colapsados individualmente
          rows.not('.local-collapsed').css('display', 'table-row').hide().fadeIn(250);
          $(this).find('.toggle-icon').text('expand_less');
        } else {
          rows.fadeOut(200);
          $(this).find('.toggle-icon').text('expand_more');
        }
      });

      $b.find('.btnExportarBloque').on('click', () => _exportarCSV(item));

      // Detener propagación para el filtro local de tabla
      $b.find('.filtro-estado-tabla').on('click', function (e) {
        e.stopPropagation();
      });

      // Filtro Local
      $b.find('.filtro-estado-tabla').on('change', function () {
        const val = $(this).val();
        const tgtClass = $(this).attr('data-target');

        $b.find('.' + tgtClass).each(function () {
          // Las filas separadoras de registro nunca se ocultan por estado
          if ($(this).data('record-header')) return;
          const isMatch = (val === 'todos' || $(this).attr('data-estado') === val);
          $(this).toggleClass('filtered-out', !isMatch);
        });
      });

      // Filtro Global
      $b.find('.filtro-estado').on('change', function () {
        const val = $(this).val();
        const sec = $(this).attr('data-seccion');
        const tb = sec === 'parametros' ? tbodyP : tbodyD;

        if (sec === 'datasets') {
          // Reseteo forzado de selectores locales
          $b.find('.filtro-estado-tabla').val('todos');
        }

        // Hide/Show celdas
        tb.find('tr[data-estado]').each(function () {
          const isMatch = (val === 'todos' || $(this).data('estado') === val);
          $(this).toggleClass('filtered-out', !isMatch);
        });

        // Hide/Show agrupadores para no dejar tables vacías visualmente
        if (sec === 'datasets') {
          tb.find('tr[data-record]').each(function () {
            const vis = $(this).nextUntil('tr[data-record], tr[data-target]').filter(':not(.filtered-out)').length > 0;
            $(this).toggleClass('filtered-out', !vis);
          });
          tb.find('.btnToggleTabla').each(function () {
            const tgt = $(this).attr('data-target');
            const hasVisibleRows = tb.find('.' + tgt + ':not(.filtered-out)').length > 0;
            $(this).toggleClass('filtered-out', !hasVisibleRows);
          });
        }
      });

      $('#emptyState').hide();
      $('#comparisonsContainer').prepend($b);
      // Animamos el scroll al nuevo insert
      $('html, body').animate({ scrollTop: $b.offset().top - 80 }, 400);
      _mostrarToast(`Comparación C${item.seqNum} añadida con éxito.`);
    }

    // Handler de Exportación Directa (Solo Pantalla Actual)
    $('#btnExportarExcel').on('click', () => {
      if (!_ejecuciones.length) return _mostrarToast('Carga un archivo XML primero.', true);
      if (GestorEstado.obtenerTodos().length === 0) {
        return _mostrarToast('No hay comparaciones en la pantalla para exportar.', true);
      }
      _generarYDescargarMatriz('pantalla');
    });

    // Motor de Matriz Excel (Con ExcelJS y Estilos de Mapa de Calor)
    async function _generarYDescargarMatriz(modo) {
      if (typeof ExcelJS === 'undefined') {
        return _mostrarToast('Error: La librería ExcelJS no ha cargado. Verifica tu conexión a internet.', true);
      }

      _mostrarToast('Construyendo matriz mapa de calor...', false);

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Matriz Traza');

      // Helper local: genera la misma clave compuesta que MotorComparacion.buildRecordKey.
      // Excluye campos técnicos que varían entre GetNew y Update, garantizando el match correcto.
      const _TECH = new Set(['SysRowID', 'SysRevID', 'RowMod', 'BitFlag']);
      function _buildExcelKey(row) {
        const parts = EPICOR_PK_FIELDS
          .filter(pk => !_TECH.has(pk) && row[pk] !== undefined && row[pk] !== null && row[pk] !== '')
          .map(pk => `${pk}=${row[pk]}`);
        if (parts.length > 0) return parts.join('|');
        return Object.entries(row).filter(([k]) => !_TECH.has(k)).map(([k, v]) => `${k}=${v}`).join('|');
      }

      // 1. Construir Línea de Tiempo (Columnas)
      const pasos = [];
      const _pasosKeySet = new Set();

      if (modo === 'todo') {
        _ejecuciones.forEach(e => {
          pasos.push({ key: `I_${e.globalIndex}`, tipo: 'input', label: `[${e.globalIndex}] In: ${e.metodo}`, data: e.input });
          pasos.push({ key: `O_${e.globalIndex}`, tipo: 'output', label: `[${e.globalIndex}] Out: ${e.metodo}`, data: e.output });
        });
      } else {
        GestorEstado.obtenerTodos().forEach(c => {
          const ea = _ejecuciones.find(e => e.globalIndex == c.idEjecucionA);
          const eb = c.tipo === 'output-vs-input' ? _ejecuciones.find(e => e.globalIndex == c.idEjecucionB) : ea;

          let ka, kb, la, lb, da, db;
          // Usamos el ID de la comparación en la key para permitir redundancia (pasos repetidos en bloques distintos)
          if (c.tipo === 'input-vs-output') {
            ka = `I_${ea.globalIndex}_${c.seqNum}`; da = ea.input; la = `[C${c.seqNum}] [${ea.globalIndex}] In: ${ea.metodo}`;
            kb = `O_${ea.globalIndex}_${c.seqNum}`; db = ea.output; lb = `[C${c.seqNum}] [${ea.globalIndex}] Out: ${ea.metodo}`;
          } else {
            ka = `O_${ea.globalIndex}_${c.seqNum}`; da = ea.output; la = `[C${c.seqNum}] [${ea.globalIndex}] Out: ${ea.metodo}`;
            kb = `I_${eb.globalIndex}_${c.seqNum}`; db = eb.input; lb = `[C${c.seqNum}] [${eb.globalIndex}] In: ${eb.metodo}`;
          }

          pasos.push({ key: ka, label: la, data: da });
          pasos.push({ key: kb, label: lb, data: db });
        });

        // NO ORDENAR: Preservar el orden de las comparaciones C1, C2, C3 tal cual están en la UI
        // pasos.sort((a,b) => { ... }); 

      }

      // 2. Extraer Nodos Únicos (Filas)
      const filasMapa = new Map();
      pasos.forEach(paso => {
        paso.data.parametros.forEach((obj, pName) => {
          const fKey = `PARAM|||${pName}`;
          if (!filasMapa.has(fKey)) filasMapa.set(fKey, { c: 'Parámetros o Sistema', t: '-', r: '-', f: pName });
        });

        paso.data.datasets.forEach((tblMap, dsName) => {
          tblMap.forEach((rows, tblName) => {
            rows.forEach(row => {
              const rKey = _buildExcelKey(row);

              Object.keys(row).forEach(fName => {
                const fKey = `DS|${tblName}|${rKey}|${fName}`;
                const esSis = ['SysRowID', 'RowMod', 'SysRevID'].includes(fName);
                if (!filasMapa.has(fKey)) {
                  filasMapa.set(fKey, { c: esSis ? 'Campos de Sistema' : 'DataSets', t: tblName, r: rKey, f: fName });
                }
              });
            });
          });
        });
      });

      // 3. Evaluar Estados y Construir Hoja
      // Configuración de Columnas
      const columnsDef = [
        { header: 'Categoría', key: 'cat', width: 18 },
        { header: 'Tabla / Entidad', key: 'tbl', width: 22 },
        { header: 'ID Único (PK)', key: 'pk', width: 35 },
        { header: 'Nodo / Campo', key: 'nodo', width: 25 }
      ];

      pasos.forEach(p => {
        columnsDef.push({ header: p.label, key: p.key, width: 26 });
      });

      worksheet.columns = columnsDef;

      // Estilos del Header Principal
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }; // Gris muy oscuro
      worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

      // Congelar paneles: 1 fila de header y 4 columnas de identificadores
      worksheet.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];

      // Colores semánticos (Hex ARGB) sincronizados con la UI
      const COLOR_IGUAL = 'FFDCFCE7';     // Verde claro (Igual)
      const COLOR_DIFERENTE = 'FFFEE2E2'; // Rojo claro (Diferente)
      const COLOR_SOBRANTE = 'FFFEF3C7';  // Amarillo/Ámbar claro (Sobrante)
      const COLOR_FALTANTE = 'FFFFF7ED';  // Naranja claro (Faltante)

      filasMapa.forEach((meta, fKey) => {
        const rowData = { cat: meta.c, tbl: meta.t, pk: String(meta.r).substring(0, 50), nodo: meta.f };
        const statesDict = {};
        let lastValue = undefined;

        for (let i = 0; i < pasos.length; i++) {
          const paso = pasos[i];
          let currVal = undefined;

          // Extraer valor temporal
          if (fKey.startsWith('PARAM')) {
            const pObj = paso.data.parametros.get(meta.f);
            if (pObj) currVal = pObj.value;
          } else {
            paso.data.datasets.forEach((tblMap, dsName) => {
              const rows = tblMap.get(meta.t);
              if (rows) {
                const r = rows.find(fila => {
                  return _buildExcelKey(fila) === meta.r;
                });
                if (r && r[meta.f] !== undefined) currVal = r[meta.f];
              }
            });
          }

          // Guardar valor para la columna (preservamos undefined para diferenciar de vacío)
          rowData[paso.key] = currVal;

          // Logica estructural para el color
          let estado = '';
          const norm = v => {
            if (v === null || v === undefined) return '';
            const s = String(v).trim();
            const n = parseFloat(s);
            return (!isNaN(n) && String(n) === s) ? n : s;
          };

          if (i > 0) {
            if (currVal !== undefined && lastValue !== undefined) {
              estado = (norm(currVal) === norm(lastValue)) ? 'IGUAL' : 'DIFERENTE';
            } else if (currVal !== undefined && lastValue === undefined) {
              estado = 'FALTANTE'; // B tiene el dato, pero A no lo envió
            } else if (currVal === undefined && lastValue !== undefined) {
              estado = 'SOBRANTE'; // A envió el dato, pero B no lo tiene
            }
          }

          statesDict[paso.key] = estado;
          lastValue = currVal;
        }

        const addedRow = worksheet.addRow(rowData);

        // Aplicar Formato a cada celda (Bucle robusto por índice de columna para asegurar procesamiento de vacías)
        for (let colNum = 1; colNum <= columnsDef.length; colNum++) {
          const cell = addedRow.getCell(colNum);
          cell.alignment = { vertical: 'middle', wrapText: true };

          // Columnas base (Identificadores)
          if (colNum <= 4) {
            cell.font = { color: { argb: 'FF475569' } };
          }
          // Columnas de Datos (Línea de tiempo)
          else {
            const pIdx = colNum - 5;
            const paso = pasos[pIdx];
            const pKey = paso.key;
            const valOriginal = rowData[pKey];
            const estado = statesDict[pKey];

            // A. Formato de Valor (Diferenciar Inexistente de Vacío)
            if (valOriginal === undefined || valOriginal === null) {
              cell.value = '—';
              cell.font = { color: { argb: 'FFA1A1AA' }, italic: true }; // Gris tenue
            } else if (String(valOriginal).trim() === '') {
              cell.value = 'VACÍO';
              cell.font = { color: { argb: 'FF94A3B8' }, italic: true }; // Gris pizarra
            } else {
              cell.value = String(valOriginal); // Asegurar que sea string
              cell.font = { color: { argb: 'FF64748B' } }; // Color base
            }

            // B. Aplicar Colores según Estado semántico
            if (estado === 'SOBRANTE') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_SOBRANTE } };
              cell.font = { color: { argb: 'FF92400E' } };
            } else if (estado === 'DIFERENTE') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_DIFERENTE } };
              cell.font = { color: { argb: 'FF991B1B' }, bold: true };
            } else if (estado === 'FALTANTE') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_FALTANTE } };
              cell.font = { color: { argb: 'FFC2410C' } };
            } else if (estado === 'IGUAL') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_IGUAL } };
              cell.font = { color: { argb: 'FF166534' } };
            }
          }
        }

      });

      // Añadir auto-filtro puro
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columnsDef.length }
      };

      // 4. Descargar Buffer
      try {
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const docName = `TrazaEpicor_MapaCalor_${modo === 'todo' ? 'Global' : 'Parcial'}_${Date.now()}.xlsx`;
        saveAs(blob, docName);
        _mostrarToast(`¡Mapa de Calor Excel descargado!`);
      } catch (err) {
        _mostrarToast(`Error generando Excel: ${err.message}`, true);
        console.error(err);
      }
    }

    $('#btnLimpiar').on('click', () => {
      if (confirm('¿Deseas eliminar todas las comparaciones de la interfaz?')) {
        GestorEstado.vaciar();
        $('#comparisonsContainer').empty();
        $('#emptyState').show();
        _mostrarToast('Historial limpio.', false);
      }
    });

    // Resetear en onLoad
    $('#tipoComparacion').trigger('change');

  })();

});
