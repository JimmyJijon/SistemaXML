/**
 * Epicor tracePacket - XML Method Comparator
 * Arquitectura modular: TraceParser | ComparisonEngine | ComparisonStore | UIRenderer
 * v2.0 — Compara parámetros y DataSets con lógica semántica estricta
 */

$(function () {

  // ════════════════════════════════════════════════════════════════════════════
  // CONSTANTES Y CONFIGURACIÓN GLOBAL
  // ════════════════════════════════════════════════════════════════════════════

  /** Enum de estados de comparación (case-sensitive) */
  const STATUS = Object.freeze({
    IGUAL:     'igual',
    DIFERENTE: 'diferente',
    SOLO_A:    'solo-a',
    SOLO_B:    'solo-b',
  });

  /** Business Objects que se deben ignorar completamente */
  const BO_IGNORADOS = ['Ice.Proxy.BO.ReportMonitorImpl'];

  /**
   * Campos de clave primaria de Epicor, en orden de prioridad.
   * Se usan para construir el recordKey de cada fila de DataSet.
   */
  const EPICOR_PK_FIELDS = [
    'SysRowID', 'JobNum', 'OrderNum', 'OrderLine', 'OrderRelNum',
    'PONum', 'POLine', 'PORelNum', 'QuoteNum', 'QuoteLine',
    'AssemblySeq', 'OprSeq', 'PartNum', 'CustNum', 'VendorNum',
    'Company',
  ];

  // ════════════════════════════════════════════════════════════════════════════
  // MÓDULO: TraceParser
  // Responsabilidad: transformar XML crudo en lista de TraceExecution.
  // ════════════════════════════════════════════════════════════════════════════

  const TraceParser = (function () {

    /**
     * Envuelve el XML en un nodo raíz para que DOMParser lo acepte
     * aunque haya múltiples <tracePacket> sin nodo raíz.
     */
    function _wrap(raw) {
      const noDecl = raw.trim().replace(/<\?xml[^?]*\?>/gi, '').trim();
      return `<root>${noDecl}</root>`;
    }


    /**
     * Extrae el mapa de SOLO parámetros simples (texto/CDATA) de una sección.
     * Ignora deliberadamente cualquier <parameter> que tenga nodos hijos XML
     * (esos son DataSets y los maneja _extractDatasets).
     *
     * Devuelve Map<name, {name, type, value}>
     */
    function _extractParamMap(sectionEl, childTag) {
      const map = new Map();
      $(sectionEl).find(`> ${childTag}`).each(function () {
        // Si tiene hijos elemento reales → es un DataSet; lo saltamos aquí.
        if (this.children && this.children.length > 0) return;

        const name  = $(this).attr('name') || '';
        const type  = $(this).attr('type') || '';
        // El valor viene como texto plano o CDATA
        const value = $(this).text().trim();
        if (name) map.set(name, { name, type, value });
      });
      return map;
    }

    /**
     * Extrae DataSets de una sección específica del tracePacket.
     *
     * Estructura REAL del XML de Epicor (sin diffgram):
     *
     *   <parameters>
     *     <parameter name="ds" type="Erp.BO.JobEntryDataSet">
     *       <JobEntryDataSet xmlns="...">          ← DataSet raíz
     *         <JobHead>                            ← fila de tabla "JobHead"
     *           <Company>PLA01</Company>           ← campo
     *           ...
     *         </JobHead>
     *         <JobHead> ... </JobHead>             ← segunda fila (si existe)
     *       </JobEntryDataSet>
     *     </parameter>
     *   </parameters>
     *
     *   <returnValues>
     *     <returnParameter name="ds" type="Erp.Tablesets.JobEntryTableset">
     *       <JobEntryDataSet xmlns="...">
     *         <JobHead> ... </JobHead>
     *       </JobEntryDataSet>
     *     </returnParameter>
     *   </returnValues>
     *
     * @param {Element} packetEl   - El elemento <tracePacket> completo
     * @param {string}  section    - 'input' | 'output'
     * @returns {Map<dsName, Map<tableName, Row[]>>}
     */
    function _extractDatasets(packetEl, section) {
      const datasets = new Map();

      // Seleccionar la sección correcta según input u output
      const sectionTag   = section === 'input' ? 'parameters'   : 'returnValues';
      const childTag     = section === 'input' ? 'parameter'     : 'returnParameter';
      const sectionEl    = packetEl.querySelector(sectionTag);
      if (!sectionEl) return datasets;

      // Iterar sobre cada <parameter> / <returnParameter>
      Array.from(sectionEl.children).forEach(function (paramEl) {
        const paramTag = paramEl.localName || paramEl.nodeName;
        if (paramTag !== childTag) return;

        // Solo nos interesan los que tienen nodos hijo XML (DataSets)
        // Los parámetros simples tienen solo texto/CDATA (children.length === 0)
        if (!paramEl.children || paramEl.children.length === 0) return;

        // ── Nivel 1: <JobEntryDataSet xmlns="..."> ─────────────────────────
        Array.from(paramEl.children).forEach(function (dsEl) {
          // dsEl es el raíz del DataSet, ej: <JobEntryDataSet>
          const dsName = dsEl.localName || dsEl.nodeName;

          // Ignorar ContextDataSet de Ice (no es un DataSet de negocio)
          if (dsName === 'ContextDataSet') return;

          if (!datasets.has(dsName)) datasets.set(dsName, new Map());
          const tblMap = datasets.get(dsName);

          // ── Nivel 2: <JobHead>, <JobProd>, etc. ───────────────────────────
          // Cada hijo inmediato del DataSet es una FILA de una tabla.
          // Si hay múltiples <JobHead>, son múltiples filas de la misma tabla.
          Array.from(dsEl.children).forEach(function (tableRowEl) {
            const tblName = tableRowEl.localName || tableRowEl.nodeName;
            if (!tblMap.has(tblName)) tblMap.set(tblName, []);

            // ── Nivel 3: campos de la fila ────────────────────────────────
            // Solo extraemos filas que tengan al menos un campo hijo
            if (!tableRowEl.children || tableRowEl.children.length === 0) return;

            const row = {};
            Array.from(tableRowEl.children).forEach(function (fieldEl) {
              const fieldName = fieldEl.localName || fieldEl.nodeName;
              // textContent da el valor limpio incluso si tiene CDATA
              row[fieldName] = fieldEl.textContent || '';
            });

            if (Object.keys(row).length > 0) {
              tblMap.get(tblName).push(row);
            }
          });

          // Si el DataSet quedó completamente vacío (sin filas), lo dejamos igual
          // porque puede indicar que el dataset existe pero está empty (válido para comparar)
        });
      });

      // ── LOG DE DIAGNÓSTICO (temporal) ──────────────────────────────────────
      if (datasets.size > 0) {
        console.group(`[TraceParser] _extractDatasets [${section}]`);
        datasets.forEach((tblMap, dsName) => {
          console.group(`  DataSet: ${dsName}`);
          tblMap.forEach((rows, tblName) => {
            console.log(`    Tabla: ${tblName} → ${rows.length} fila(s)`);
            if (rows.length > 0) {
              console.log(`      Campos: ${Object.keys(rows[0]).slice(0, 8).join(', ')}${Object.keys(rows[0]).length > 8 ? '…' : ''}`);
            }
          });
          console.groupEnd();
        });
        console.groupEnd();
      } else {
        console.log(`[TraceParser] _extractDatasets [${section}]: sin DataSets en <${sectionTag}>`);
      }

      return datasets;
    }

    /**
     * Parsea el XML crudo y retorna un array de TraceExecution:
     * {
     *   globalIndex,     // Posición absoluta en el archivo (1-based)
     *   methodIndex,     // Índice para este methodName específico (1-based)
     *   label,           // "MethodName [N]"
     *   methodName,
     *   businessObject,
     *   input:  { parameters: Map, datasets: Map },
     *   output: { parameters: Map, datasets: Map },
     * }
     */
    function parse(raw) {
      const wrapped = _wrap(raw);
      const doc = new DOMParser().parseFromString(wrapped, 'application/xml');

      if (doc.querySelector('parsererror')) {
        throw new Error('El archivo no es un XML válido. Verifique el formato.');
      }

      const packets = doc.querySelectorAll('tracePacket');
      if (!packets.length) {
        throw new Error('No se encontraron elementos <tracePacket> en el archivo.');
      }

      const nameCount  = {};
      const executions = [];
      let   globalIdx  = 0;

      packets.forEach(function (packet) {
        const methodName = $(packet).find('> methodName').text().trim();
        if (!methodName) return;

        const businessObject = $(packet).find('> businessObject').text().trim()
          || $(packet).find('> objectName').text().trim()
          || $(packet).attr('service') || '';

        // Ignorar BOs de la lista negra
        if (BO_IGNORADOS.some(bo => businessObject.includes(bo) || methodName.includes(bo))) return;

        globalIdx++;
        nameCount[methodName] = (nameCount[methodName] || 0) + 1;
        const methodIndex = nameCount[methodName];

        // Extraer parámetros de entrada
        const paramSection  = packet.querySelector('parameters');
        const returnSection = packet.querySelector('returnValues');

        const execution = {
          globalIndex:    globalIdx,
          methodIndex:    methodIndex,
          label:          `${methodName} [${methodIndex}]`,
          methodName:     methodName,
          businessObject: businessObject,
          input: {
            parameters: paramSection
              ? _extractParamMap(paramSection, 'parameter')
              : new Map(),
            datasets: _extractDatasets(packet, 'input'),
          },
          output: {
            parameters: returnSection
              ? _extractParamMap(returnSection, 'returnParameter')
              : new Map(),
            datasets: _extractDatasets(packet, 'output'),
          },
        };

        // ── LOG DE DIAGNÓSTICO por método (temporal) ────────────────────────
        console.group(`[TraceParser] [${execution.globalIndex}] ${execution.label}`);
        console.log('  input.params  :', execution.input.parameters.size);
        console.log('  input.datasets:', execution.input.datasets.size);
        console.log('  output.params :', execution.output.parameters.size);
        console.log('  output.datasets:', execution.output.datasets.size);
        console.groupEnd();

        executions.push(execution);

      });

      if (!executions.length) {
        throw new Error('No se encontraron métodos válidos. Verifique que los <tracePacket> tengan <methodName>.');
      }

      return executions;
    }

    /** Retorna lista única de businessObjects para poblar el selector */
    function getBusinessObjects(executions) {
      const bos = new Set(executions.map(e => e.businessObject || '(desconocido)'));
      return [...bos].filter(Boolean).sort();
    }

    return { parse, getBusinessObjects };
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // MÓDULO: ComparisonEngine
  // Responsabilidad: normalizar y comparar dos conjuntos de datos (DataA vs DataB).
  // ════════════════════════════════════════════════════════════════════════════

  const ComparisonEngine = (function () {

    // ── Normalización ──────────────────────────────────────────────────────────

    /**
     * Determina el tipo de un valor para normalización.
     * El type viene del XML como "System.Int32", "System.Boolean", etc.
     */
    function _typeCategory(typeStr) {
      if (!typeStr) return 'string';
      const t = typeStr.toLowerCase();
      if (t.includes('int') || t.includes('decimal') || t.includes('double')
          || t.includes('float') || t.includes('single') || t.includes('numeric'))
        return 'numeric';
      if (t.includes('bool')) return 'boolean';
      return 'string';
    }

    /**
     * Normaliza un valor antes de comparar.
     * Reglas:
     *  - Numérico: parseFloat → comparar valor real (0 == 0.00)
     *  - Booleano: case-sensitive estricto (false != False)
     *  - String:   trim() solamente
     *  - null/undefined → cadena vacía para comparación
     */
    function normalize(value, typeStr) {
      if (value === null || value === undefined) return '';
      const str = String(value);
      const cat = _typeCategory(typeStr);

      if (cat === 'numeric') {
        const n = parseFloat(str);
        return isNaN(n) ? str.trim() : n;
      }
      // Booleanos: NO alterar, solo trim
      return str.trim();
    }

    /**
     * Compara dos valores normalizados.
     * Devuelve true si son iguales.
     */
    function _valuesEqual(valA, typeA, valB, typeB) {
      const nA = normalize(valA, typeA);
      const nB = normalize(valB, typeB);
      return nA === nB;
    }

    // ── Clave de Registro ──────────────────────────────────────────────────────

    /**
     * Construye el recordKey de una fila buscando campos primarios de Epicor.
     * Si no hay ninguno, concatena todos los valores para garantizar unicidad.
     */
    function buildRecordKey(row) {
      const parts = [];
      for (const pk of EPICOR_PK_FIELDS) {
        if (pk in row && row[pk] !== '' && row[pk] !== null) {
          parts.push(`${pk}=${row[pk]}`);
        }
      }
      if (parts.length) return parts.join('|');

      // Fallback: hash de todos los valores
      return Object.entries(row)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
    }

    // ── Comparación de Parámetros ──────────────────────────────────────────────

    /**
     * Compara dos Map<name, {name, type, value}> de parámetros.
     * Devuelve lista de DiffResult.
     * DiffResult: { category:'parametros', path, name, typeA, typeB, valA, valB, status }
     */
    function compareParameters(mapA, mapB) {
      const results = [];
      const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

      allKeys.forEach(key => {
        const pA = mapA.get(key);
        const pB = mapB.get(key);

        if (pA && pB) {
          const eq = _valuesEqual(pA.value, pA.type, pB.value, pB.type);
          results.push({
            category: 'parametros',
            path:   `Parámetros.${key}`,
            name:   key,
            typeA:  pA.type,
            typeB:  pB.type,
            valA:   pA.value,
            valB:   pB.value,
            status: eq ? STATUS.IGUAL : STATUS.DIFERENTE,
          });
        } else if (pA && !pB) {
          results.push({
            category: 'parametros',
            path:   `Parámetros.${key}`,
            name:   key,
            typeA:  pA.type, typeB: '',
            valA:   pA.value, valB: null,
            status: STATUS.SOLO_A,
          });
        } else {
          results.push({
            category: 'parametros',
            path:   `Parámetros.${key}`,
            name:   key,
            typeA: '', typeB: pB.type,
            valA:   null, valB: pB.value,
            status: STATUS.SOLO_B,
          });
        }
      });

      // Ordenar: diferente/solo primero, igual al final
      const order = { [STATUS.DIFERENTE]: 0, [STATUS.SOLO_A]: 1, [STATUS.SOLO_B]: 2, [STATUS.IGUAL]: 3 };
      return results.sort((a, b) => (order[a.status] || 0) - (order[b.status] || 0));
    }

    // ── Comparación de DataSets ────────────────────────────────────────────────

    /**
     * Compara dos Map<dsName, Map<tblName, Row[]>> de datasets.
     * Devuelve lista de DiffResult más detallados con flatKey y recordKey.
     * DiffResult: { category:'datasets', dsName, tableName, recordKey, flatKey, fieldName, typeA, typeB, valA, valB, status }
     */
    function compareDatasets(datasetsA, datasetsB) {
      const results = [];
      const allDs = new Set([...datasetsA.keys(), ...datasetsB.keys()]);

      allDs.forEach(dsName => {
        const tablesA = datasetsA.get(dsName) || new Map();
        const tablesB = datasetsB.get(dsName) || new Map();
        const allTbls = new Set([...tablesA.keys(), ...tablesB.keys()]);

        allTbls.forEach(tblName => {
          const rowsA = tablesA.get(tblName) || [];
          const rowsB = tablesB.get(tblName) || [];

          // Indexar por recordKey
          const mapA = new Map();
          rowsA.forEach(row => mapA.set(buildRecordKey(row), row));
          const mapB = new Map();
          rowsB.forEach(row => mapB.set(buildRecordKey(row), row));

          const allRecords = new Set([...mapA.keys(), ...mapB.keys()]);

          allRecords.forEach(recKey => {
            const rowA = mapA.get(recKey);
            const rowB = mapB.get(recKey);

            if (rowA && rowB) {
              // Comparar campo a campo
              const allFields = new Set([...Object.keys(rowA), ...Object.keys(rowB)]);
              allFields.forEach(field => {
                const vA = rowA[field];
                const vB = rowB[field];
                let status;
                if (vA !== undefined && vB !== undefined) {
                  // FIX 1: Inferir tipo numérico desde el valor (DataSets no traen type en XML).
                  // Si AMBOS valores son parseable como número → comparar como número.
                  // Esto evita falsos DIFERENTE entre "0" y "0.00", "1" y "1.0", etc.
                  const nA = parseFloat(vA);
                  const nB = parseFloat(vB);
                  const bothNumeric = !isNaN(nA) && !isNaN(nB) && String(vA).trim() !== '' && String(vB).trim() !== '';
                  const typeHint = bothNumeric ? 'numeric' : '';
                  status = _valuesEqual(vA, typeHint, vB, typeHint) ? STATUS.IGUAL : STATUS.DIFERENTE;
                } else if (vA !== undefined) {
                  status = STATUS.SOLO_A;
                } else {
                  status = STATUS.SOLO_B;
                }
                results.push({
                  category:  'datasets',
                  dsName,
                  tableName: tblName,
                  recordKey: recKey,
                  flatKey:   `${tblName}.${field}`,
                  fieldName: field,
                  typeA: '', typeB: '',
                  valA: vA !== undefined ? vA : null,
                  valB: vB !== undefined ? vB : null,
                  status,
                });
              });
            } else if (rowA && !rowB) {
              // Fila entera solo en A
              Object.keys(rowA).forEach(field => {
                results.push({
                  category:  'datasets',
                  dsName, tableName: tblName,
                  recordKey: recKey,
                  flatKey:   `${tblName}.${field}`,
                  fieldName: field,
                  typeA: '', typeB: '',
                  valA: rowA[field], valB: null,
                  status: STATUS.SOLO_A,
                });
              });
            } else {
              // Fila entera solo en B
              Object.keys(rowB).forEach(field => {
                results.push({
                  category:  'datasets',
                  dsName, tableName: tblName,
                  recordKey: recKey,
                  flatKey:   `${tblName}.${field}`,
                  fieldName: field,
                  typeA: '', typeB: '',
                  valA: null, valB: rowB[field],
                  status: STATUS.SOLO_B,
                });
              });
            }
          });
        });
      });

      return results;
    }

    /**
     * Punto de entrada principal del motor.
     * dataA/B = { parameters: Map, datasets: Map }
     * scope   = 'parametros' | 'datasets' | 'ambos'
     */
    function run(dataA, dataB, scope) {
      let paramResults = [];
      let dsResults    = [];

      if (scope === 'parametros' || scope === 'ambos') {
        paramResults = compareParameters(dataA.parameters, dataB.parameters);
      }
      if (scope === 'datasets' || scope === 'ambos') {
        dsResults = compareDatasets(dataA.datasets, dataB.datasets);
      }

      return { paramResults, dsResults };
    }

    return { run, normalize, buildRecordKey };
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // MÓDULO: ComparisonStore
  // Responsabilidad: persistir histórico de comparaciones en la sesión.
  // ════════════════════════════════════════════════════════════════════════════

  const ComparisonStore = (function () {
    const _comparisons = []; // Array de ComparisonUnit
    let   _counter     = 0;

    function add(unit) {
      _counter++;
      unit.seqNum = _counter;
      _comparisons.push(unit);
      return unit;
    }

    function getAll()     { return [..._comparisons]; }
    function count()      { return _comparisons.length; }
    function clear()      { _comparisons.length = 0; _counter = 0; }
    function getById(id)  { return _comparisons.find(c => c.id === id); }

    return { add, getAll, count, clear, getById };
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // MÓDULO: UIRenderer
  // Responsabilidad: generar y gestionar el DOM de resultados.
  // ════════════════════════════════════════════════════════════════════════════

  const UIRenderer = (function () {

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _esc(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _valDisplay(val, altClass) {
      if (val === null || val === undefined) {
        return `<span class="italic text-outline/40 text-[11px]">—</span>`;
      }
      return `<span class="font-mono text-[11px] ${altClass || ''}">${_esc(String(val))}</span>`;
    }

    /** Badge visual de estado */
    // FIX 6: _badge ahora acepta un segundo argumento opcional con el tipo de comparación
    // para mostrar etiquetas semánticas en lugar del técnico "SOLO EN A / SOLO EN B".
    function _badge(status, tipoComparacion) {
      const map = {
        [STATUS.IGUAL]:     'bg-green-100 text-green-700',
        [STATUS.DIFERENTE]: 'bg-red-100 text-red-700',
        [STATUS.SOLO_A]:    'bg-amber-100 text-amber-800',
        [STATUS.SOLO_B]:    'bg-cyan-100 text-cyan-800',
      };
      // Etiquetas contextuales según el tipo de comparación
      let labelSoloA, labelSoloB;
      if (tipoComparacion === 'input-vs-output') {
        labelSoloA = 'SOLO EN INPUT';
        labelSoloB = 'SOLO EN OUTPUT';
      } else if (tipoComparacion === 'output-vs-input') {
        labelSoloA = 'SOLO EN OUTPUT A';
        labelSoloB = 'SOLO EN INPUT B';
      } else {
        labelSoloA = 'SOLO EN A';
        labelSoloB = 'SOLO EN B';
      }
      const label = {
        [STATUS.IGUAL]:     'IGUAL',
        [STATUS.DIFERENTE]: 'DIFERENTE',
        [STATUS.SOLO_A]:    labelSoloA,
        [STATUS.SOLO_B]:    labelSoloB,
      };
      const cls = map[status] || 'bg-gray-100 text-gray-700';
      return `<span class="px-2 py-0.5 rounded-full ${cls} text-[9px] font-bold">${label[status] || status}</span>`;
    }

    /** Prefijo de sangría por nivel */
    function _indent(level) {
      const pxMap = { 0: 'pl-6', 1: 'pl-10', 2: 'pl-16', 3: 'pl-24', 4: 'pl-32' };
      return pxMap[Math.min(level, 4)] || 'pl-32';
    }

    /** Icono de expand/collapse */
    function _toggleIcon(expanded) {
      return expanded
        ? '<span class="material-symbols-outlined text-xs toggle-icon">expand_more</span>'
        : '<span class="material-symbols-outlined text-xs toggle-icon">chevron_right</span>';
    }

    // ── Construcción de filas de parámetros ───────────────────────────────────

    /**
     * Genera el <tbody> de la tabla de parámetros para un bloque.
     * Agrupa todas las filas bajo un nodo raíz "Parámetros".
     */
    // FIX 6: _buildParamRows y _buildDatasetRows reciben tipoComparacion para badges semánticos
    function _buildParamRows(paramResults, compId, tipoComparacion) {
      if (!paramResults.length) {
        return `<tr><td colspan="4" class="px-6 py-8 text-center text-outline text-xs italic">Sin parámetros para comparar.</td></tr>`;
      }

      const rootId     = `${compId}-sec-params`;
      const totalDiffs = paramResults.filter(r => r.status !== STATUS.IGUAL).length;
      let html = '';

      // Nodo raíz
      html += `
        <tr class="bg-surface-container-low/30 border-b border-outline-variant/10"
            data-node-type="section"
            data-node-id="${rootId}"
            data-expanded="true"
            data-expandable="true"
            data-estado="${totalDiffs > 0 ? STATUS.DIFERENTE : STATUS.IGUAL}">
          <td class="px-6 py-2 font-bold" colspan="1">
            <div class="flex items-center gap-2">
              ${_toggleIcon(true)}
              <span class="material-symbols-outlined text-xs text-primary">list_alt</span>
              Parámetros de Entrada
            </div>
          </td>
          <td colspan="3" class="px-6 py-2 text-[10px] text-outline italic">
            ${paramResults.length} parámetros · ${totalDiffs} diferencia${totalDiffs !== 1 ? 's' : ''}
          </td>
        </tr>`;

      // Filas hoja
      paramResults.forEach(r => {
        const rowStateClass = `data-${r.status}`;
        const nodeId = `${compId}-param-${r.name.replace(/[^a-z0-9]/gi, '_')}`;
        html += `
          <tr class="hover:bg-surface-container-low transition-colors ${rowStateClass}"
              data-node-type="field"
              data-node-id="${nodeId}"
              data-parent-id="${rootId}"
              data-estado="${r.status}"
              data-expandable="false">
            <td class="px-6 py-1.5 ${_indent(1)} relative">
              <div class="flex items-center gap-2 tree-connector ml-2">
                ${_esc(r.name)}
                <span class="text-[9px] text-outline font-mono ml-1">${_esc(r.typeA || r.typeB)}</span>
              </div>
            </td>
            <td class="px-6 py-1.5">${_valDisplay(r.valA)}</td>
            <td class="px-6 py-1.5">${_valDisplay(r.valB)}</td>
            <td class="px-6 py-1.5">${_badge(r.status, tipoComparacion)}</td>
          </tr>`;
      });

      return html;
    }

    // ── Construcción de filas de DataSets ─────────────────────────────────────

    /**
     * Genera el <tbody> de la tabla de DataSets para un bloque.
     * Estructura jerárquica: DataSet → Tabla → Registro → Campo
     */
    function _buildDatasetRows(dsResults, compId, tipoComparacion) {
      if (!dsResults.length) {
        return `<tr><td colspan="4" class="px-6 py-8 text-center text-outline text-xs italic">Sin DataSets para comparar.</td></tr>`;
      }

      let html = '';

      // Agrupar: dsName → tableName → recordKey → [fields]
      const grouped = new Map();
      dsResults.forEach(r => {
        if (!grouped.has(r.dsName)) grouped.set(r.dsName, new Map());
        const tblMap = grouped.get(r.dsName);
        if (!tblMap.has(r.tableName)) tblMap.set(r.tableName, new Map());
        const recMap = tblMap.get(r.tableName);
        if (!recMap.has(r.recordKey)) recMap.set(r.recordKey, []);
        recMap.get(r.recordKey).push(r);
      });

      grouped.forEach((tblMap, dsName) => {
        const dsId     = `${compId}-ds-${dsName.replace(/[^a-z0-9]/gi, '_')}`;
        const dsDiffs  = dsResults.filter(r => r.dsName === dsName && r.status !== STATUS.IGUAL).length;
        const dsStatus = dsDiffs > 0 ? STATUS.DIFERENTE : STATUS.IGUAL;

        // Nodo DataSet
        html += `
          <tr class="bg-surface-container-low/30 border-b border-outline-variant/10"
              data-node-type="dataset"
              data-node-id="${dsId}"
              data-expanded="true"
              data-expandable="true"
              data-estado="${dsStatus}">
            <td class="px-6 py-2 font-bold">
              <div class="flex items-center gap-2">
                ${_toggleIcon(true)}
                <span class="material-symbols-outlined text-xs text-secondary">database</span>
                ${_esc(dsName)}
              </div>
            </td>
            <td colspan="3" class="px-6 py-2 text-[10px] text-outline italic">
              ${tblMap.size} tabla${tblMap.size !== 1 ? 's' : ''} · ${dsDiffs} diferencia${dsDiffs !== 1 ? 's' : ''}
            </td>
          </tr>`;

        tblMap.forEach((recMap, tblName) => {
          const tblId    = `${compId}-tbl-${dsName.replace(/[^a-z0-9]/gi, '_')}-${tblName.replace(/[^a-z0-9]/gi, '_')}`;
          const tblDiffs = [...recMap.values()].flat().filter(r => r.status !== STATUS.IGUAL).length;
          const tblStatus = tblDiffs > 0 ? STATUS.DIFERENTE : STATUS.IGUAL;

          // Nodo Tabla
          html += `
            <tr class="bg-surface-container-low/10 border-t border-outline-variant/5"
                data-node-type="table"
                data-node-id="${tblId}"
                data-parent-id="${dsId}"
                data-expanded="true"
                data-expandable="true"
                data-estado="${tblStatus}">
              <td class="px-6 py-1.5 ${_indent(1)} font-semibold">
                <div class="flex items-center gap-2">
                  ${_toggleIcon(true)}
                  <span class="material-symbols-outlined text-xs opacity-50">table_rows</span>
                  ${_esc(tblName)}
                  <span class="text-[9px] text-outline font-normal">(DataTable)</span>
                </div>
              </td>
              <td colspan="3" class="px-6 text-[10px] text-outline italic">
                ${recMap.size} registro${recMap.size !== 1 ? 's' : ''} · ${tblDiffs} diferencia${tblDiffs !== 1 ? 's' : ''}
              </td>
            </tr>`;

          recMap.forEach((fields, recKey) => {
            const recId     = `${compId}-rec-${tblId}-${_hashStr(recKey)}`;
            const recDiffs  = fields.filter(f => f.status !== STATUS.IGUAL).length;
            const recStatus = recDiffs > 0 ? STATUS.DIFERENTE : STATUS.IGUAL;

            // Nodo Registro
            html += `
              <tr data-node-type="record"
                  data-node-id="${recId}"
                  data-parent-id="${tblId}"
                  data-record-key="${_esc(recKey)}"
                  data-expanded="true"
                  data-expandable="true"
                  data-estado="${recStatus}">
                <td class="px-6 py-1.5 ${_indent(2)} font-medium text-on-surface-variant">
                  <div class="flex items-center gap-2">
                    ${_toggleIcon(true)}
                    <span class="text-[10px] font-mono bg-surface-container px-1.5 py-0.5 rounded">
                      Row: ${_esc(recKey)}
                    </span>
                  </div>
                </td>
                <td colspan="3" class="px-6 py-1.5 text-[10px] text-outline italic">
                  ${fields.length} campo${fields.length !== 1 ? 's' : ''} · ${recDiffs} diferencia${recDiffs !== 1 ? 's' : ''}
                </td>
              </tr>`;

            // Ordenar: no-iguales primero
            const sortedFields = [...fields].sort((a, b) => {
              if (a.status === STATUS.IGUAL && b.status !== STATUS.IGUAL) return 1;
              if (a.status !== STATUS.IGUAL && b.status === STATUS.IGUAL) return -1;
              return 0;
            });

            sortedFields.forEach(f => {
              const fieldId = `${recId}-${f.fieldName.replace(/[^a-z0-9]/gi, '_')}`;
              html += `
                <tr class="hover:bg-surface-container-low transition-colors data-${f.status}"
                    data-node-type="field"
                    data-node-id="${fieldId}"
                    data-parent-id="${recId}"
                    data-field-name="${_esc(f.fieldName)}"
                    data-estado="${f.status}"
                    data-expandable="false">
                  <td class="px-6 py-1 ${_indent(3)} text-[11px]">${_esc(f.fieldName)}</td>
                  <td class="px-6 py-1">${_valDisplay(f.valA)}</td>
                  <td class="px-6 py-1">${_valDisplay(f.valB)}</td>
                  <td class="px-6 py-1">${_badge(f.status, tipoComparacion)}</td>
                </tr>`;
            });
          });
        });
      });

      return html;
    }

    /** Hash simple para generar IDs únicos desde el recordKey */
    function _hashStr(str) {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
      }
      return Math.abs(h).toString(36);
    }

    // ── Render de un bloque de comparación ────────────────────────────────────

    /**
     * Instancia el template #tmplComparacionBlock y lo rellena con los datos
     * de la ComparisonUnit. Devuelve el elemento jQuery listo para insertar.
     */
    function renderBlock(unit) {
      const tmpl     = document.getElementById('tmplComparacionBlock');
      const $block   = $(tmpl.content.cloneNode(true)).find('section');
      const compId   = unit.id;
      const seqNum   = unit.seqNum;
      const scope    = unit.config.tipoDato;

      // Atributos del bloque contenedor
      $block
        .attr('data-comparacion-id',   compId)
        .attr('data-tipo-comparacion', unit.config.tipoComparacion)
        .attr('data-scope',            scope)
        .attr('data-metodo-a',         unit.config.metodoA)
        .attr('data-metodo-b',         unit.config.metodoB);

      // Badge y contexto
      $block.find('.comparacion-badge').text(`C${seqNum}`);
      $block.find('.comparacion-contexto').text(unit.contextLabel);

      // Etiqueta tipo análisis
      const tipoLabel = unit.config.tipoComparacion === 'input-vs-output'
        ? 'Input A → Output A'
        : 'Output A → Input B';
      $block.find('.comparacion-tipo-label').text(tipoLabel);

      // Botón exportar por bloque
      $block.find('.btnExportarBloque').attr('data-comparacion-id', compId);

      // Sincronizar data-comparacion-id en filtros
      $block.find('.filtro-estado').attr('data-comparacion-id', compId);

      // Visibilidad de secciones según scope
      const showParams   = scope === 'parametros' || scope === 'ambos';
      const showDatasets = scope === 'datasets'   || scope === 'ambos';
      $block.find('.comparacion-seccion-parametros').toggle(showParams);
      $block.find('.comparacion-seccion-datasets').toggle(showDatasets);

      // Rellenar tbodies — FIX 6: pasar tipoComparacion para badges semánticos
      if (showParams) {
        $block.find('.tbodyParametros').html(
          _buildParamRows(unit.results.paramResults, compId, unit.config.tipoComparacion)
        );
      }
      if (showDatasets) {
        $block.find('.tbodyDatasets').html(
          _buildDatasetRows(unit.results.dsResults, compId, unit.config.tipoComparacion)
        );
      }

      // Estadísticas del footer
      const totalNodes = unit.results.paramResults.length + unit.results.dsResults.length;
      const totalDiffs = [...unit.results.paramResults, ...unit.results.dsResults]
        .filter(r => r.status !== STATUS.IGUAL).length;
      $block.find('.comparacion-stats').text(
        `Nodos Analizados: ${totalNodes} | Diferencias: ${totalDiffs}`
      );

      return $block;
    }

    /** Actualiza el estado "vacío" del contenedor principal */
    function showEmptyState(show) {
      const $empty = $('#emptyState');
      if ($empty.length) $empty.toggle(show);
    }

    return { renderBlock, showEmptyState };
  })();

  // ════════════════════════════════════════════════════════════════════════════
  // ESTADO DE LA APLICACIÓN
  // ════════════════════════════════════════════════════════════════════════════

  let _executions = []; // Lista de TraceExecution (resultado del parser)
  let _currentFile = null;

  // ════════════════════════════════════════════════════════════════════════════
  // CARGA DE ARCHIVO
  // ════════════════════════════════════════════════════════════════════════════

  // Click en dropZone → abre fileInput
  // IMPORTANTE: usar .click() nativo para evitar que jQuery propague el evento
  // de vuelta al dropZone (que lo dispararía infinitamente).
  $('#dropZone').on('click', function (e) {
    // Si el click viene del propio input (burbujeo), ignorar
    if ($(e.target).is('#fileInput') || $(e.target).closest('#fileInput').length) return;
    document.getElementById('fileInput').click(); // nativo, sin bubbling jQuery
  });

  // Selección por input file — stopPropagation para no llegar al dropZone
  $('#fileInput').on('click', function (e) {
    e.stopPropagation();
  });
  $('#fileInput').on('change', function () {
    if (this.files[0]) _setFile(this.files[0]);
  });


  // Drag & Drop
  $('#dropZone')
    .on('dragover', function (e) {
      e.preventDefault();
      $(this).addClass('bg-surface-container-low border-secondary');
    })
    .on('dragleave', function () {
      $(this).removeClass('bg-surface-container-low border-secondary');
    })
    .on('drop', function (e) {
      e.preventDefault();
      $(this).removeClass('bg-surface-container-low border-secondary');
      const f = e.originalEvent.dataTransfer.files[0];
      if (f) _setFile(f);
    });

  function _setFile(file) {
    _currentFile = file;
    $('#fileName').text(file.name);
  }

  // Quitar archivo
  $('#btnRemoveFile').on('click', function () {
    _currentFile = null;
    $('#fileName').text('Sin archivo');
    $('#fileInput').val('');
    _executions = [];
    _resetSelectors();
  });

  // Cargar y parsear el XML
  $('#btnCargarXml').on('click', function () {
    if (!_currentFile) { alert('Por favor seleccione un archivo primero.'); return; }
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        _executions = TraceParser.parse(e.target.result);
        _populateSelectors(_executions);
        _showToast(`✓ ${_executions.length} métodos cargados correctamente.`, 'success');
      } catch (err) {
        alert('Error al procesar el archivo:\n' + err.message);
        console.error(err);
      }
    };
    reader.onerror = () => alert('No se pudo leer el archivo. Intente de nuevo.');
    reader.readAsText(_currentFile, 'UTF-8');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SELECTORES (Business Object y Método)
  // ════════════════════════════════════════════════════════════════════════════

  function _resetSelectors() {
    ['#selectBusinessObjectA', '#selectBusinessObjectB'].forEach(sel => {
      $(sel).empty().append('<option value="">— Cargue un archivo —</option>');
    });
    ['#selectMetodoA', '#selectMetodoB'].forEach(sel => {
      $(sel).empty().append('<option value="">— Seleccione Fuente —</option>');
    });
  }

  function _populateSelectors(executions) {
    const bos = TraceParser.getBusinessObjects(executions);

    ['#selectBusinessObjectA', '#selectBusinessObjectB'].forEach(sel => {
      const $sel = $(sel).empty();
      $sel.append('<option value="">— Seleccione BO —</option>');
      bos.forEach(bo => $sel.append($('<option>', { value: bo, text: bo })));
      if (bos.length === 1) $sel.val(bos[0]).trigger('change');
    });
  }

  function _populateMethodSelector(selectorId, businessObject) {
    const $sel = $(selectorId).empty();
    $sel.append('<option value="">— Seleccione Método —</option>');

    const filtered = _executions.filter(e =>
      !businessObject || e.businessObject === businessObject
    );
    filtered.forEach(e => {
      $sel.append($('<option>', { value: e.label, text: `[${e.globalIndex}] ${e.label}` }));
    });
  }

  // Cambio en BO A → poblar Métodos A
  $('#selectBusinessObjectA').on('change', function () {
    _populateMethodSelector('#selectMetodoA', $(this).val());
  });

  // Cambio en BO B → poblar Métodos B
  $('#selectBusinessObjectB').on('change', function () {
    _populateMethodSelector('#selectMetodoB', $(this).val());
  });

  // ════════════════════════════════════════════════════════════════════════════
  // AGREGAR COMPARACIÓN (#btnAgregarComparacion)
  // ════════════════════════════════════════════════════════════════════════════

  $('#btnAgregarComparacion').on('click', function () {
    // 1. Validaciones previas
    if (!_executions.length) {
      alert('Primero cargue un archivo XML.'); return;
    }

    const labelA = $('#selectMetodoA').val();
    const labelB = $('#selectMetodoB').val();
    const tipo   = $('#tipoComparacion').val();
    const scope  = $('#tipoDatoComparado').val();

    if (!labelA) { alert('Seleccione el Método A.'); return; }
    if (tipo === 'output-vs-input' && !labelB) {
      alert('Seleccione el Método B.'); return;
    }

    const execA = _executions.find(e => e.label === labelA);
    if (!execA) { alert('No se encontró el Método A.'); return; }

    // 2. Determinar qué datos comparar
    let dataA, dataB, contextLabel;

    if (tipo === 'input-vs-output') {
      // FIX 3: Validar que el método A tenga output antes de continuar.
      // Si returnType es void o no tiene returnValues, avisar al usuario.
      const outputParams  = execA.output.parameters.size;
      const outputDatasets = execA.output.datasets.size;
      if (outputParams === 0 && outputDatasets === 0) {
        const proceed = confirm(
          `El método "${execA.label}" no tiene valores de retorno (puede ser void).\n` +
          `La comparación mostrará todos los campos de Input como SOLO EN INPUT.\n\n` +
          `¿Desea continuar de todas formas?`
        );
        if (!proceed) return;
      }
      dataA        = execA.input;
      dataB        = execA.output;
      contextLabel = `Input ${execA.label} vs Output ${execA.label}`;
    } else {
      // output-vs-input
      const execB = _executions.find(e => e.label === labelB);
      if (!execB) { alert('No se encontró el Método B.'); return; }
      dataA        = execA.output;
      dataB        = execB.input;
      contextLabel = `Output ${execA.label} vs Input ${execB.label}`;
    }

    // 3. Ejecutar comparación
    const results = ComparisonEngine.run(dataA, dataB, scope);

    // 4. Guardar en el store
    // FIX 4: metodoB solo se guarda cuando aplica (output-vs-input).
    // En input-vs-output, metodoB = null para no contaminar el CSV.
    const unit = ComparisonStore.add({
      id:           `comp_${Date.now()}`,
      config:       {
        metodoA:         labelA,
        metodoB:         tipo === 'output-vs-input' ? labelB : null,
        tipoComparacion: tipo,
        tipoDato:        scope,
      },
      contextLabel: contextLabel,
      rawDataA:     dataA,
      rawDataB:     dataB,
      results:      results,
    });

    // 5. Renderizar bloque y añadir al contenedor (SIN borrar anteriores)
    const $block = UIRenderer.renderBlock(unit);
    $('#comparisonsContainer').append($block);

    // Ocultar estado vacío si es la primera comparación
    _toggleEmptyState(false);

    // Scroll suave al nuevo bloque
    $('html, body').animate({ scrollTop: $block.offset().top - 80 }, 400);

    _showToast(`Comparación C${unit.seqNum} agregada.`, 'success');
  });

  // #btnComparar = alias del botón "Ejecutar Análisis" (también agrega)
  $('#btnComparar').on('click', function () {
    $('#btnAgregarComparacion').trigger('click');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // INTERACTIVIDAD: Expand/Collapse (delegación de eventos)
  // ════════════════════════════════════════════════════════════════════════════

  $('#comparisonsContainer').on('click', '[data-expandable="true"]', function (e) {
    // Evitar que el clic en un select hijo active esto
    if ($(e.target).is('select') || $(e.target).closest('select').length) return;

    const $row    = $(this);
    const nodeId  = $row.attr('data-node-id');
    const isOpen  = $row.attr('data-expanded') === 'true';

    $row.attr('data-expanded', isOpen ? 'false' : 'true');

    // Cambiar ícono
    $row.find('.toggle-icon').first().text(isOpen ? 'chevron_right' : 'expand_more');

    // Mostrar/ocultar todos los descendientes
    _toggleDescendants(nodeId, !isOpen, $row.closest('table'));
  });

  /**
   * Muestra u oculta recursivamente todos los nodos cuyo data-parent-id
   * pertenece al subárbol del nodo dado.
   */
  function _toggleDescendants(parentId, show, $table) {
    $table.find(`[data-parent-id="${parentId}"]`).each(function () {
      const $child  = $(this);
      const childId = $child.attr('data-node-id');

      $child.toggle(show);

      // Si estamos mostrando, respetar el estado de expansión del hijo
      if (show) {
        const childExpanded = $child.attr('data-expanded');
        // Si el hijo está colapsado, sus descendientes deben permanecer ocultos
        const propagate = childExpanded !== 'false';
        if (childId) _toggleDescendants(childId, propagate, $table);
      } else {
        // Ocultar todo el subárbol
        if (childId) _toggleDescendants(childId, false, $table);
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INTERACTIVIDAD: Colapsar/Expandir Bloque Completo
  // ════════════════════════════════════════════════════════════════════════════

  $('#comparisonsContainer').on('click', '.btnColapsarBloque', function () {
    const $btn  = $(this);
    const $body = $btn.closest('.comparacion-block').find('.comparacion-body');
    const $icon = $btn.find('.material-symbols-outlined');

    $body.slideToggle(200);
    $icon.text($body.is(':visible') ? 'expand_less' : 'expand_more');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FILTROS POR ESTADO (por sección y por bloque)
  // ════════════════════════════════════════════════════════════════════════════

  $('#comparisonsContainer').on('change', '.filtro-estado', function () {
    const $sel      = $(this);
    const compId    = $sel.attr('data-comparacion-id');
    const seccion   = $sel.attr('data-seccion'); // 'parametros' | 'datasets'
    const filterVal = $sel.val(); // 'todos' | 'igual' | 'diferente' | 'solo-a' | 'solo-b'

    // Buscar el bloque correspondiente
    const $block  = $(`[data-comparacion-id="${compId}"]`);
    const $tbody  = seccion === 'parametros'
      ? $block.find('.tbodyParametros')
      : $block.find('.tbodyDatasets');

    // Paso 1: Mostrar/ocultar filas hoja (field)
    $tbody.find('[data-node-type="field"]').each(function () {
      const $row   = $(this);
      const estado = $row.attr('data-estado');
      if (filterVal === 'todos' || estado === filterVal) {
        $row.show();
      } else {
        $row.hide();
      }
    });

    // FIX 5: Tras filtrar fields, ocultar nodos padre (record, table, dataset, section)
    // que no tengan ningún hijo visible. Se recorre de dentro hacia afuera.
    const parentTypes = ['record', 'table', 'dataset', 'section'];
    parentTypes.forEach(function (nodeType) {
      $tbody.find(`[data-node-type="${nodeType}"]`).each(function () {
        const $parentRow = $(this);
        const nodeId     = $parentRow.attr('data-node-id');
        // Buscar hijos directos (data-parent-id apunta a este nodo)
        const $children  = $tbody.find(`[data-parent-id="${nodeId}"]`);
        // Si todos los hijos están ocultos → ocultar el padre también
        const hasVisible = $children.filter(':visible').length > 0;
        $parentRow.toggle(hasVisible);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // EXPORTAR EXCEL (CSV) — por bloque y global
  // ════════════════════════════════════════════════════════════════════════════

  $('#comparisonsContainer').on('click', '.btnExportarBloque', function () {
    const compId = $(this).attr('data-comparacion-id');
    const unit   = ComparisonStore.getById(compId);
    if (!unit) return;
    _exportUnit(unit);
  });

  $('#btnExportarExcel').on('click', function () {
    const all = ComparisonStore.getAll();
    if (!all.length) { alert('No hay comparaciones para exportar.'); return; }
    all.forEach(u => _exportUnit(u));
  });

  function _exportUnit(unit) {
    const BOM     = '\uFEFF';
    const headers = ['Comparacion', 'Categoria', 'Ruta', 'Campo', 'ValorA', 'ValorB', 'Estado'];

    const rows = [
      ...unit.results.paramResults.map(r => [
        unit.contextLabel, 'Parámetros', r.path, r.name,
        _csvCell(r.valA), _csvCell(r.valB), r.status,
      ]),
      ...unit.results.dsResults.map(r => [
        unit.contextLabel, 'DataSets',
        `${r.dsName}.${r.tableName}[${r.recordKey}]`,
        r.fieldName,
        _csvCell(r.valA), _csvCell(r.valB), r.status,
      ]),
    ];

    const csv  = BOM + [headers, ...rows].map(r => r.map(_csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const $a   = $('<a>', { href: url, download: `comparacion_${unit.seqNum}_${Date.now()}.csv` }).appendTo('body');
    $a[0].click();
    $a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function _csvCell(val) {
    const str = String(val === null || val === undefined ? '' : val);
    return (str.includes(',') || str.includes('"') || str.includes('\n'))
      ? `"${str.replace(/"/g, '""')}"` : str;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LIMPIAR TODO
  // ════════════════════════════════════════════════════════════════════════════

  $('#btnLimpiar').on('click', function () {
    ComparisonStore.clear();
    // Eliminar todos los bloques pero mantener el #emptyState si existe
    $('#comparisonsContainer .comparacion-block').remove();
    _toggleEmptyState(true);
    _showToast('Comparaciones eliminadas.', 'info');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // UTILIDAD: Toast de notificación
  // ════════════════════════════════════════════════════════════════════════════

  /** Muestra/Oculta el mensaje de "No hay comparaciones" */
  function _toggleEmptyState(show) {
    const $empty = $('#emptyState');
    if ($empty.length) $empty.toggle(show);
  }

  function _showToast(msg, type) {
    const colors = {
      success: 'bg-green-600',
      info:    'bg-primary',
      warn:    'bg-amber-500',
      error:   'bg-red-600',
    };
    const $toast = $(`
      <div class="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-xl text-white text-xs font-bold flex items-center gap-2 ${colors[type] || colors.info}">
        ${_escToast(msg)}
      </div>`).appendTo('body');
    setTimeout(() => $toast.fadeOut(300, () => $toast.remove()), 2800);
  }

  function _escToast(str) {
    if (!str) return '';
    return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ESTADO INICIAL
  // ════════════════════════════════════════════════════════════════════════════

  _resetSelectors();

  // ════════════════════════════════════════════════════════════════════════════
  // FIX 2: Control de visibilidad de selectores B según tipo de comparación.
  // Cuando el usuario elige "input-vs-output", Fuente B y Método B se deshabilitan
  // visualmente porque no aplican. Solo se activan en "output-vs-input".
  // ════════════════════════════════════════════════════════════════════════════

  function _syncSelectorBVisibility() {
    const tipo = $('#tipoComparacion').val();
    const needsB = tipo === 'output-vs-input';

    // Selectores de Fuente B y Método B
    const $srcB    = $('#selectBusinessObjectB');
    const $metB    = $('#selectMetodoB');

    // Deshabilitar / habilitar campos
    $srcB.prop('disabled', !needsB);
    $metB.prop('disabled', !needsB);

    // Opacidad visual para indicar estado
    [$srcB, $metB].forEach($el => {
      $el.closest('div, label').toggleClass('opacity-40 pointer-events-none', !needsB);
    });

    // Si se desactiva B, limpiar selección para evitar que un valor anterior
    // quede "seleccionado" silenciosamente y contamine la comparación.
    if (!needsB) {
      $srcB.val('');
      $metB.empty().append('<option value="">— No aplica —</option>');
    }
  }

  // Ejecutar al cambiar tipo de comparación
  $('#tipoComparacion').on('change', _syncSelectorBVisibility);

  // Ejecutar al inicio para setear el estado correcto según el valor por defecto del select
  _syncSelectorBVisibility();

}); // end $(function)
