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

        // Si tiene hijos elementos, no es un par de clave/valor simple, es un DataSet.
        if (param.children && param.children.length > 0) return;

        const name = $(param).attr('name') || '';
        const type = $(param).attr('type') || '';
        const val = $(param).text().trim();

        if (name) mapa.set(name, { name, type, value: val });
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
            status: STATUS.SOBRANTE // Input vs Output A -> Está en el Input y no en Output.
          });
        } else {
          resultados.push({
            categoria: 'parametros', name: k,
            valA: null, valB: b.value,
            status: STATUS.FALTANTE // Output A vs Input B -> Falta en A pero está en B.
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
        [STATUS.FALTANTE]: '<span class="px-2 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-700">FALTANTE</span>'
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
        try {
          _ejecuciones = XmlParser.parsearXML(e.target.result);
          _llenarCombos();
          _mostrarToast(`¡Éxito! Se procesaron ${_ejecuciones.length} métodos.`);
        } catch (err) {
          _mostrarToast(err.message, true);
        }
      };
      reader.readAsText(file, 'UTF-8');
    }).on('dragover', e => e.preventDefault());

    $('#btnCargarXml, #dropZone').on('click', function (e) {
      if (e.target.id === 'fileInput') return;
      $('#fileInput')[0].click();
    });

    $('#btnRemoveFile').on('click', () => {
      _ejecuciones = [];
      $('#fileName').text('Sin archivo');
      $('#fileInput').val('');
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

    $('#btnAgregarComparacion, #btnComparar').on('click', function () {
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
        contexto = `Input ${ea.label} vs Output ${ea.label}`;
      } else {
        dataA = ea.output; dataB = eb.input;
        contexto = `Output ${ea.label} vs Input ${eb.label}`;
      }

      const resul = MotorComparacion.comparar(dataA, dataB, scope);
      const item = GestorEstado.agregar({ labelA, labelB, tipo, scope, contexto, resultados: resul });

      _renderTablas(item);
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
              <td class="px-6 py-2 pl-10 font-mono text-xs">${_escapar(r.name)} <span class="text-[9px] text-gray-500">${r.typeA || r.typeB}</span></td>
              <td class="px-6 py-2 w-1/4 break-words">${_formatoValor(r.valA)}</td>
              <td class="px-6 py-2 w-1/4 break-words">${_formatoValor(r.valB)}</td>
              <td class="px-6 py-2">${_badge(r.status)}</td>
            </tr>
          `);
        });
        if (!item.resultados.parametros.length) tbodyP.append('<tr><td colspan="4" class="text-center p-4 text-xs italic text-gray-400">Sin parámetros procesados.</td></tr>');
      } else {
        $b.find('.comparacion-seccion-parametros').hide();
      }

      if (item.scope !== 'parametros') {
        // Agrupar filas para ordenar el display visualmente 
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
            // Header: Fila de Tabla
            let rootLabel = '';
            const testField = filas.values().next().value?.[0]; // Inspeccionar una celda de sample
            if (testField && testField.dsNameA) rootLabel += `A: ${testField.dsNameA}`;
            if (testField && testField.dsNameB) rootLabel += (rootLabel ? ' | ' : '') + `B: ${testField.dsNameB}`;

            tbodyD.append(`
              <tr class="bg-surface-container-low font-bold border-b border-outline-variant/10" data-table="${tname}">
                <td colspan="4" class="px-6 py-2 text-on-surface font-mono text-xs flex gap-2 items-center">
                  <span class="material-symbols-outlined text-[14px]">table_rows</span> ${tname} 
                  <span class="text-[9px] font-normal text-gray-500">(${rootLabel || 'N/A'})</span>
                </td>
              </tr>
            `);

            filas.forEach((campos, rkey) => {
              // Sub Header: Fila Identificadora de Row
              tbodyD.append(`
                <tr class="bg-surface-container-low/40 border-b border-outline-variant/10 text-xs text-on-surface" data-record="${rkey}">
                  <td colspan="4" class="px-6 py-1.5 pl-10 font-bold flex gap-2 items-center">
                     <span class="material-symbols-outlined text-[12px]">dataset</span> ID Registro: ${rkey}
                  </td>
                </tr>
              `);

              // Ordenar celdas priorizando diferentes arriba
              const sorteados = campos.sort((a, b) => {
                const s1 = a.status === STATUS.IGUAL ? 1 : 0;
                const s2 = b.status === STATUS.IGUAL ? 1 : 0;
                return s1 - s2;
              });

              sorteados.forEach(c => {
                tbodyD.append(`
                  <tr class="border-b border-outline-variant/10 hover:bg-surface-container-low transition-colors data-${c.status}" data-estado="${c.status}">
                    <td class="px-6 py-1.5 pl-[72px] text-[11px] font-mono">${_escapar(c.fieldName)}</td>
                    <td class="px-6 py-1.5 w-1/4 break-words">${_formatoValor(c.valA)}</td>
                    <td class="px-6 py-1.5 w-1/4 break-words">${_formatoValor(c.valB)}</td>
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
        $b.find('.comparacion-body').slideToggle();
        const $i = $(this).find('span');
        $i.text($i.text().includes('expand_more') ? 'expand_less' : 'expand_more');
      });

      $b.find('.btnExportarBloque').on('click', () => _exportarCSV(item));

      // Filtro local en Acordeon 
      $b.find('.filtro-estado').on('change', function () {
        const val = $(this).val();
        const sec = $(this).attr('data-seccion');
        const tb = sec === 'parametros' ? tbodyP : tbodyD;

        // Hide/Show celdas
        tb.find('tr[data-estado]').each(function () {
          $(this).toggle(val === 'todos' || $(this).data('estado') === val);
        });

        // Hide/Show agrupadores para no dejar tables colgadas sin rows child
        if (sec === 'datasets') {
          tb.find('tr[data-record]').each(function () {
            const vis = $(this).nextUntil('tr[data-record], tr[data-table]').filter(':visible').length > 0;
            $(this).toggle(vis);
          });
          tb.find('tr[data-table]').each(function () {
            const vis = $(this).nextUntil('tr[data-table]').filter(':visible').length > 0;
            $(this).toggle(vis);
          });
        }
      });

      $('#emptyState').hide();
      $('#comparisonsContainer').prepend($b);
      // Animamos el scroll al nuevo insert
      $('html, body').animate({ scrollTop: $b.offset().top - 80 }, 400);
      _mostrarToast(`Comparación C${item.seqNum} añadida con éxito.`);
    }

    // Exportador de datos 
    function _exportarCSV(item) {
      if (!item) return;
      const mapLegacy = { [STATUS.IGUAL]: 'igual', [STATUS.DIFERENTE]: 'diferente', [STATUS.SOBRANTE]: 'solo-a', [STATUS.FALTANTE]: 'solo-b' };
      const csv = ['Contexto,Categoria,SubRuta,Campo,ValorA,ValorB,Estado,Estado_Legacy'];

      const cel = v => v ? `"${String(v).replace(/"/g, '""')}"` : '';

      item.resultados.parametros.forEach(p => {
        csv.push(`"${item.contexto}","Parametros","Params","${p.name}",${cel(p.valA)},${cel(p.valB)},${p.status},${mapLegacy[p.status]}`);
      });
      item.resultados.datasets.forEach(d => {
        csv.push(`"${item.contexto}","DataSets","${d.tblName}[${d.recordKey}]","${d.fieldName}",${cel(d.valA)},${cel(d.valB)},${d.status},${mapLegacy[d.status]}`);
      });

      const blob = new Blob(['\uFEFF' + csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `C${item.seqNum}_export_${Date.now()}.csv`;
      a.click();
    }

    $('#btnExportarExcel').on('click', () => {
      GestorEstado.obtenerTodos().forEach(i => _exportarCSV(i));
    });

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
