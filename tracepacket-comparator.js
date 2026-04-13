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
    'Company'
  ];

  const BO_IGNORADOS = ['Ice.Proxy.BO.ReportMonitorImpl'];

  // ==========================================
  // XmlParser
  // ==========================================
  const XmlParser = (function () {

    function parsearXML(xmlString) {
      // Remover cabeceras XML que rompan el parsing sin un wrapper global y encerrar todo
      const raw = xmlString.trim().replace(/<\?xml[^?]*\?>/gi, '').trim();
      const wrapped = `<root>${raw}</root>`;
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

        // Función auxiliar recursiva para aplanar nodos
        function _aplanar(node, currentPath) {
          const children = Array.from(node.children).filter(c => c.nodeType === 1);
          if (children.length === 0) {
            // Nodo hoja: guardar valor
            const val = $(node).text().trim();
            mapa.set(currentPath, { name: currentPath, type: typeAttr, value: val });
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
          // Se deja para que lo procese extraerDatasets() y se vea en las tablas inferiores.
          return;
        }

        // Parámetro simple (llave/valor)
        const val = $(param).text().trim();
        if (nameAttr) mapa.set(nameAttr, { name: nameAttr, type: typeAttr, value: val });
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
              children.forEach(field => {
                let fname = field.localName || field.nodeName;
                if (fname.includes(':')) fname = fname.split(':')[1];
                row[fname] = field.textContent || '';
              });
              if (Object.keys(row).length > 0) tblMap.get(tblName).push(row);
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
      // Buscar la primera clave primaria válida en orden
      for (const pk of EPICOR_PK_FIELDS) {
        if (row[pk] !== undefined && row[pk] !== null && row[pk] !== '') {
          return `${pk}=${row[pk]}`;
        }
      }
      // Hash backup de todos los campos
      return Object.entries(row).map(([k, v]) => `${k}=${v}`).join('|');
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
            status: eq ? STATUS.IGUAL : STATUS.DIFERENTE
          });
        } else if (a) {
          resultados.push({
            categoria: 'parametros', name: k,
            valA: a.value, valB: null,
            typeA: a.type, typeB: null,
            status: STATUS.SOBRANTE 
          });
        } else {
          resultados.push({
            categoria: 'parametros', name: k,
            valA: null, valB: b.value,
            typeA: null, typeB: b.type,
            status: STATUS.FALTANTE 
          });
        }
      });

      const order = { [STATUS.DIFERENTE]: 1, [STATUS.SOBRANTE]: 2, [STATUS.FALTANTE]: 3, [STATUS.IGUAL]: 4 };
      return resultados.sort((x, y) => order[x.status] - order[y.status]);
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

        const mapA = new Map(), mapB = new Map();
        rowsA.forEach(r => mapA.set(buildRecordKey(r), r));
        rowsB.forEach(r => mapB.set(buildRecordKey(r), r));

        const keys = new Set([...mapA.keys(), ...mapB.keys()]);

        keys.forEach(k => {
          const rowA = mapA.get(k);
          const rowB = mapB.get(k);

          if (rowA && rowB) {
            const fields = new Set([...Object.keys(rowA), ...Object.keys(rowB)]);
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
                recordKey: k, fieldName: f, valA: va, valB: vb, status: st
              });
            });
          } else if (rowA) {
            Object.keys(rowA).forEach(f => {
              resultados.push({
                categoria: 'datasets', tblName, dsNameA: tbA?.dsName, dsNameB: null,
                recordKey: k, fieldName: f, valA: rowA[f], valB: null, status: STATUS.SOBRANTE
              });
            });
          } else {
            Object.keys(rowB).forEach(f => {
              resultados.push({
                categoria: 'datasets', tblName, dsNameA: null, dsNameB: tbB?.dsName,
                recordKey: k, fieldName: f, valA: null, valB: rowB[f], status: STATUS.FALTANTE
              });
            });
          }
        });
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
        $(sId).append(`<option value="${e.label}">[${e.globalIndex}] ${e.label}</option>`);
      });
    });

    $('#tipoComparacion').on('change', function () {
      const needsB = $(this).val() === 'output-vs-input';
      $('#selectBusinessObjectB, #selectMetodoB').prop('disabled', !needsB)
        .parent().toggleClass('opacity-40', !needsB);
    });

    $('#btnComparar').on('click', function () {
      if (!_ejecuciones.length) return _mostrarToast('Carga un archivo XML primero.', true);

      const labelA = $('#selectMetodoA').val();
      const labelB = $('#selectMetodoB').val();
      const tipo = $('#tipoComparacion').val();
      const scope = $('#tipoDatoComparado').val();

      if (tipo !== 'input-vs-output' && tipo !== 'output-vs-input') {
        return _mostrarToast('Modo de comparación no soportado. Abortando.', true);
      }

      if (!labelA) return _mostrarToast('Selecciona el Método A', true);
      if (tipo === 'output-vs-input' && !labelB) return _mostrarToast('Selecciona el Método B', true);

      const ea = _ejecuciones.find(e => e.label === labelA);
      const eb = tipo === 'output-vs-input' ? _ejecuciones.find(e => e.label === labelB) : ea;

      let dataA, dataB, contexto;
      if (tipo === 'input-vs-output') {
        dataA = ea.input; dataB = ea.output;
        contexto = ea.label; // Ejemplo: ChangeJob [1]
      } else {
        dataA = ea.output; dataB = eb.input;
        contexto = `${ea.label} vs ${eb.label}`; // Ejemplo: Job [1] vs Order [1]
      }

      const resul = MotorComparacion.comparar(dataA, dataB, scope);
      const item = GestorEstado.agregar({ labelA, labelB, tipo, scope, contexto, resultados: resul });

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
        item.resultados.parametros.forEach(r => {
          tbodyP.append(`
            <tr class="border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors data-${r.status}" data-estado="${r.status}">
              <td class="px-6 py-2 pl-10 font-mono text-xs truncate" title="${_escapar(r.name)}">${_escapar(r.name)} <span class="text-[9px] text-gray-500">${r.typeA || r.typeB}</span></td>
              <td class="px-6 py-2 break-all overflow-hidden">${_formatoValor(r.valA)}</td>
              <td class="px-6 py-2 break-all overflow-hidden">${_formatoValor(r.valB)}</td>
              <td class="px-6 py-2">${_badge(r.status)}</td>
            </tr>
          `);
        });
        if (!item.resultados.parametros.length) tbodyP.append('<tr><td colspan="4" class="text-center p-4 text-xs italic text-gray-400">Sin parámetros procesados.</td></tr>');
      } else {
        $b.find('.comparacion-seccion-parametros').hide();
      }

      if (item.scope !== 'parametros') {
        const tbm = new Map();
        item.resultados.datasets.forEach(r => {
          if (!tbm.has(r.tblName)) tbm.set(r.tblName, new Map());
          if (!tbm.get(r.tblName).has(r.recordKey)) tbm.get(r.tblName).set(r.recordKey, []);
          tbm.get(r.tblName).get(r.recordKey).push(r);
        });

        if (tbm.size === 0) {
          tbodyD.append('<tr><td colspan="4" class="text-center p-4 text-xs italic text-gray-400">Sin DataSets encontrados.</td></tr>');
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

            tbodyD.append(`
              <tr class="bg-surface-container-low border-b border-outline-variant/30 cursor-pointer hover:bg-surface-container transition-colors btnToggleTabla" data-target="${tableIdClass}">
                <td colspan="4" class="px-6 pt-5 pb-3 text-on-surface">
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
                          <option value="todos">Todos los estados</option>
                          <option value="igual">Igual</option>
                          <option value="diferente">Diferente</option>
                          <option value="sobrante">Sobrante</option>
                          <option value="faltante">Faltante</option>
                        </select>
                        <span class="material-symbols-outlined text-sm text-primary/50 toggle-icon">expand_more</span>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            `);

            filas.forEach((campos, rkey) => {
              const sorteados = campos.sort((a, b) => {
                const s1 = a.status === STATUS.IGUAL ? 1 : 0;
                const s2 = b.status === STATUS.IGUAL ? 1 : 0;
                return s1 - s2;
              });

              sorteados.forEach(c => {
                // Filtro de campos técnicos de Epicor
                if (['SysRowID', 'RowMod', 'SysRevID'].includes(c.fieldName)) return;

                tbodyD.append(`
                  <tr class="border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors data-${c.status} ${tableIdClass}" data-estado="${c.status}" style="display:none;">
                    <td class="px-6 py-1.5 pl-10 text-[11px] font-mono font-medium truncate" title="${_escapar(c.fieldName)}">${_escapar(c.fieldName)}</td>
                    <td class="px-6 py-1.5 break-all overflow-hidden">${_formatoValor(c.valA)}</td>
                    <td class="px-6 py-1.5 break-all overflow-hidden">${_formatoValor(c.valB)}</td>
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

      $b.find('.btnToggleTabla').on('click', function () {
        const tgt = $(this).attr('data-target');
        const rows = $b.find(`.${tgt}`);
        const isHidden = rows.first().is(':hidden');

        if (isHidden) {
          // Asegurar display: table-row para evitar descuadres en layout fijo
          rows.css('display', 'table-row').hide().fadeIn(250);
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

    // Handlers del Modal de Exportación
    $('#btnExportarExcel').on('click', () => {
      if (!_ejecuciones.length) return _mostrarToast('Carga un archivo XML primero.', true);
      $('#modalExportExcel').removeClass('hidden').addClass('flex');
    });

    $('#btnCloseModal').on('click', () => {
      $('#modalExportExcel').removeClass('flex').addClass('hidden');
    });

    $('#btnExportAllXML').on('click', () => {
      $('#modalExportExcel').removeClass('flex').addClass('hidden');
      _generarYDescargarMatriz('todo');
    });

    $('#btnExportUIOnly').on('click', () => {
      if (GestorEstado.obtenerTodos().length === 0) {
        return _mostrarToast('No hay comparaciones en la pantalla para exportar.', true);
      }
      $('#modalExportExcel').removeClass('flex').addClass('hidden');
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
          const ea = _ejecuciones.find(e => e.label === c.labelA);
          const eb = c.tipo === 'output-vs-input' ? _ejecuciones.find(e => e.label === c.labelB) : ea;
          
          let ka, kb, la, lb, da, db;
          if (c.tipo === 'input-vs-output') {
              ka = `I_${ea.globalIndex}`; da = ea.input; la = `[${ea.globalIndex}] In: ${ea.metodo}`;
              kb = `O_${ea.globalIndex}`; db = ea.output; lb = `[${ea.globalIndex}] Out: ${ea.metodo}`;
          } else {
              ka = `O_${ea.globalIndex}`; da = ea.output; la = `[${ea.globalIndex}] Out: ${ea.metodo}`;
              kb = `I_${eb.globalIndex}`; db = eb.input; lb = `[${eb.globalIndex}] In: ${eb.metodo}`;
          }

          if (!_pasosKeySet.has(ka)) { _pasosKeySet.add(ka); pasos.push({ key: ka, label: la, data: da }); }
          if (!_pasosKeySet.has(kb)) { _pasosKeySet.add(kb); pasos.push({ key: kb, label: lb, data: db }); }
        });
        
        pasos.sort((a,b) => {
           const [tA, idxA] = a.key.split('_');
           const [tB, idxB] = b.key.split('_');
           if (idxA !== idxB) return parseInt(idxA) - parseInt(idxB);
           return tA === 'I' ? -1 : 1; 
        });
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
              let rKey = '-';
              for (const pk of EPICOR_PK_FIELDS) {
                if (row[pk] !== undefined && row[pk] !== null && row[pk] !== '') {
                  rKey = `${pk}=${row[pk]}`; break;
                }
              }
              if (rKey === '-') rKey = Object.entries(row).map(([k, v]) => `${k}=${v}`).join('|');

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
         const rowData = { cat: meta.c, tbl: meta.t, pk: String(meta.r).substring(0,50), nodo: meta.f };
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
                         let tempK = '-';
                         for (const pk of EPICOR_PK_FIELDS) {
                           if (fila[pk] !== undefined && fila[pk] !== null && fila[pk] !== '') {
                             tempK = `${pk}=${fila[pk]}`; break;
                           }
                         }
                         if (tempK === '-') tempK = Object.entries(fila).map(([k, v]) => `${k}=${v}`).join('|');
                         return tempK === meta.r;
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
      } catch(err) {
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
