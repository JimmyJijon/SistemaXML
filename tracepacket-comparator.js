/**
 * Epicor tracePacket - XML Method Comparator
 * Compara outputs de un método A vs inputs de un método B
 * Comparación semántica por nombre + tipo (NO por posición ni texto crudo)
 */

$(function () {
  // ─── Estado global ──────────────────────────────────────────────────────────
  let methods = []; // [{ index, label, methodName, inputs: [{name,type}], outputs: [{name,type}] }]
  let currentResults = []; // [{ param, type, outputVal, inputVal, estado }]
  let activeFilter = "todos";

  // ─── Utilidades ─────────────────────────────────────────────────────────────

  /**
   * Envuelve los tracePackets sueltos en un nodo raíz para que DOMParser los acepte.
   * El archivo TXT tiene múltiples <tracePacket> sin nodo raíz.
   */
  function wrapXml(raw) {
    const trimmed = raw.trim();
    // Si ya tiene declaración XML, la quitamos para evitar conflictos
    const noDecl = trimmed.replace(/<\?xml[^?]*\?>/gi, "").trim();
    return `<root>${noDecl}</root>`;
  }

  /**
   * Extrae [{name, type}] de los <parameter> hijos directos de <parameters>
   */
  function extractParameters(packetEl) {
    const result = [];
    $(packetEl)
      .find("parameters > parameter")
      .each(function () {
        result.push({
          name: $(this).attr("name") || "",
          type: $(this).attr("type") || "",
        });
      });
    return result;
  }

  /**
   * Extrae [{name, type}] de los <returnParameter> hijos directos de <returnValues>
   */
  function extractReturnValues(packetEl) {
    const result = [];
    $(packetEl)
      .find("returnValues > returnParameter")
      .each(function () {
        result.push({
          name: $(this).attr("name") || "",
          type: $(this).attr("type") || "",
        });
      });
    return result;
  }

  /**
   * Parsea el archivo TXT/XML y construye el array de métodos.
   * Retorna el array o lanza un Error con mensaje descriptivo.
   */
  function parseXmlFile(raw) {
    const wrapped = wrapXml(raw);
    const parser = new DOMParser();
    const doc = parser.parseFromString(wrapped, "application/xml");

    // Verificar errores de parseo
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      throw new Error("El archivo no es un XML válido. Verifique el formato.");
    }

    const packets = doc.querySelectorAll("tracePacket");
    if (!packets.length) {
      throw new Error(
        "No se encontraron elementos <tracePacket> en el archivo.",
      );
    }

    // Contador por methodName para asignar índice [1], [2], ...
    const nameCount = {};
    const parsed = [];

    packets.forEach(function (packet) {
      const methodName = $(packet).find("> methodName").text().trim();
      if (!methodName) return; // ignorar packets sin methodName

      nameCount[methodName] = (nameCount[methodName] || 0) + 1;
      const idx = nameCount[methodName];

      parsed.push({
        index: idx,
        label: `${methodName} [${idx}]`,
        methodName: methodName,
        inputs: extractParameters(packet),
        outputs: extractReturnValues(packet),
      });
    });

    if (!parsed.length) {
      throw new Error(
        "No se encontraron métodos válidos con <methodName> en el archivo.",
      );
    }

    return parsed;
  }

  /**
   * Poblar ambos selects con los métodos cargados.
   */
  function populateSelects(methodList) {
    const $output = $("#metodoOutput").empty();
    const $input = $("#metodoInput").empty();

    methodList.forEach(function (m) {
      $output.append($("<option>", { value: m.label, text: m.label }));
      $input.append($("<option>", { value: m.label, text: m.label }));
    });

    // Seleccionar distintos por defecto si hay más de uno
    if (methodList.length > 1) {
      $input.val(methodList[1].label);
    }
  }

  // ─── Comparación semántica ───────────────────────────────────────────────────

  /**
   * Compara outputs de método A vs inputs de método B.
   * Retorna array de resultados clasificados.
   */
  function compareMethodOutputVsInput(methodA, methodB) {
    const outputsA = methodA.outputs; // [{name, type}]
    const inputsB = methodB.inputs; // [{name, type}]

    const results = [];

    // Clave de comparación: name + type (case-sensitive, como viene del XML)
    const makeKey = (p) => `${p.name}::${p.type}`;

    const outputMap = new Map();
    outputsA.forEach((p) => outputMap.set(makeKey(p), p));

    const inputMap = new Map();
    inputsB.forEach((p) => inputMap.set(makeKey(p), p));

    // IGUALES y FALTANTES: recorrer inputs de B
    inputsB.forEach(function (paramB) {
      const key = makeKey(paramB);
      if (outputMap.has(key)) {
        results.push({
          param: paramB.name,
          type: paramB.type,
          outputVal: outputMap.get(key).name,
          inputVal: paramB.name,
          estado: "IGUAL",
        });
      } else {
        // B necesita este param pero A no lo tiene en outputs
        results.push({
          param: paramB.name,
          type: paramB.type,
          outputVal: null, // A no lo tiene
          inputVal: paramB.name,
          estado: "FALTANTE",
        });
      }
    });

    // SOBRANTES: outputs de A que B no tiene en inputs
    outputsA.forEach(function (paramA) {
      const key = makeKey(paramA);
      if (!inputMap.has(key)) {
        results.push({
          param: paramA.name,
          type: paramA.type,
          outputVal: paramA.name,
          inputVal: null, // B no lo usa
          estado: "SOBRANTE",
        });
      }
    });

    return results;
  }

  // ─── Renderizado de tabla ────────────────────────────────────────────────────

  const STATUS_CONFIG = {
    IGUAL: {
      rowClass: "",
      barColor: "bg-[#22c55e]",
      badgeBg: "bg-[#dcfce7]",
      badgeText: "text-[#166534]",
      badgeBorder: "border-[#22c55e]/20",
    },
    FALTANTE: {
      rowClass: "bg-[#fee2e2]/30 hover:bg-[#fee2e2]/50",
      barColor: "bg-error",
      badgeBg: "bg-[#fee2e2]",
      badgeText: "text-error",
      badgeBorder: "border-error/20",
    },
    SOBRANTE: {
      rowClass: "bg-[#fef3c7]/30 hover:bg-[#fef3c7]/50",
      barColor: "bg-amber-500",
      badgeBg: "bg-[#fef3c7]",
      badgeText: "text-[#92400e]",
      badgeBorder: "border-amber-500/20",
    },
  };

  function buildRow(item) {
    const cfg = STATUS_CONFIG[item.estado] || STATUS_CONFIG["IGUAL"];

    const outputDisplay =
      item.outputVal != null
        ? `<span class="font-medium text-sm">${escHtml(item.outputVal)}</span>`
        : `<span class="italic text-outline/50 text-sm">—</span>`;

    const inputDisplay =
      item.inputVal != null
        ? `<span class="font-medium text-sm">${escHtml(item.inputVal)}</span>`
        : `<span class="italic text-outline/50 text-sm">—</span>`;

    const defaultRowBase =
      "bg-surface-container-lowest hover:bg-surface-container-low/50";
    const rowClass = cfg.rowClass || defaultRowBase;

    return `
      <tr class="${rowClass} transition-colors group" data-estado="${item.estado}">
        <td class="px-6 py-4 font-medium text-sm">
          <div class="flex items-center gap-3">
            <div class="w-1 h-6 ${cfg.barColor} rounded-full flex-shrink-0"></div>
            ${escHtml(item.param)}
          </div>
        </td>
        <td class="px-6 py-4 text-xs font-mono text-outline">${escHtml(item.type)}</td>
        <td class="px-6 py-4">${outputDisplay}</td>
        <td class="px-6 py-4">${inputDisplay}</td>
        <td class="px-6 py-4">
          <div class="flex justify-center">
            <span class="${cfg.badgeBg} ${cfg.badgeText} text-[10px] font-black uppercase px-3 py-1 rounded-full border ${cfg.badgeBorder} tracking-widest">
              ${item.estado}
            </span>
          </div>
        </td>
      </tr>`;
  }

  function escHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderTable(results, filter) {
    const $tbody = $("#tbodyResultados");
    $tbody.empty();

    const filtered =
      filter === "todos"
        ? results
        : results.filter(
            (r) =>
              r.estado.toLowerCase() === filter.slice(0, -1).toUpperCase() ||
              matchFilter(r.estado, filter),
          );

    if (!filtered.length) {
      $tbody.html(`
        <tr>
          <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
            No hay parámetros para mostrar con el filtro seleccionado.
          </td>
        </tr>`);
    } else {
      filtered.forEach((item) => $tbody.append(buildRow(item)));
    }

    // Actualizar contador en footer
    updateFooter(filtered.length, results.length);
  }

  function matchFilter(estado, filter) {
    const map = {
      iguales: "IGUAL",
      faltantes: "FALTANTE",
      sobrantes: "SOBRANTE",
    };
    return estado === (map[filter] || "");
  }

  function updateFooter(shown, total) {
    // El footer está en el HTML; actualizamos solo el texto del span
    const $footer = $(".px-6.py-4.flex.justify-between span.text-xs");
    if ($footer.length) {
      $footer.text(`Mostrando ${shown} de ${total} parámetros encontrados`);
    }
  }

  // ─── Exportar CSV/Excel ──────────────────────────────────────────────────────

  function exportToExcel(results, labelA, labelB) {
    const BOM = "\uFEFF"; // BOM para que Excel detecte UTF-8

    const headers = ["MetodoA", "MetodoB", "Parametro", "Tipo", "Estado"];

    const rows = results.map((r) => [
      csvCell(labelA),
      csvCell(labelB),
      csvCell(r.param),
      csvCell(r.type),
      csvCell(r.estado),
    ]);

    const csvLines = [headers.join(","), ...rows.map((r) => r.join(","))];
    const csvContent = BOM + csvLines.join("\r\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `tracePacket_comparacion_${timestamp}.csv`;

    const $a = $("<a>", {
      href: url,
      download: filename,
    }).appendTo("body");
    $a[0].click();
    $a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(val) {
    const str = String(val == null ? "" : val);
    // Escapar celdas con comas, comillas o saltos
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ─── Carga de archivo ────────────────────────────────────────────────────────

  let currentFile = null;

  function resetFileUI() {
    currentFile = null;
    $("#fileName").text("");
    $("#fileInput").val("");
  }

  function loadFile(file) {
    if (!file) return;
    currentFile = file;
    $("#fileName").text(file.name);
  }

  // Click en zona de drop → abre fileInput
  $("#dropZone").on("click", function () {
    $("#fileInput").trigger("click");
  });

  // Selección por input file
  $("#fileInput").on("change", function () {
    const file = this.files[0];
    if (file) loadFile(file);
  });

  // Drag & Drop
  $("#dropZone")
    .on("dragover", function (e) {
      e.preventDefault();
      $(this).addClass("bg-surface-container-low border-secondary");
    })
    .on("dragleave", function () {
      $(this).removeClass("bg-surface-container-low border-secondary");
    })
    .on("drop", function (e) {
      e.preventDefault();
      $(this).removeClass("bg-surface-container-low border-secondary");
      const file = e.originalEvent.dataTransfer.files[0];
      if (file) loadFile(file);
    });

  // Eliminar archivo
  $("#btnRemoveFile").on("click", function () {
    resetFileUI();
    methods = [];
    currentResults = [];
    $("#metodoOutput, #metodoInput")
      .empty()
      .append("<option>— Cargue un archivo —</option>");
    $("#tbodyResultados").html(`
      <tr>
        <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
          Cargue un archivo XML para comenzar.
        </td>
      </tr>`);
  });

  // ─── Cargar XML ─────────────────────────────────────────────────────────────

  $("#btnCargarXml").on("click", function () {
    if (!currentFile) {
      alert("Por favor seleccione un archivo primero.");
      return;
    }

    const reader = new FileReader();

    reader.onload = function (e) {
      try {
        methods = parseXmlFile(e.target.result);
        populateSelects(methods);

        // Limpiar tabla anterior
        $("#tbodyResultados").html(`
          <tr>
            <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
              Archivo cargado: <strong>${methods.length} métodos encontrados</strong>.
              Seleccione Método A y Método B y presione Comparar.
            </td>
          </tr>`);

        currentResults = [];
      } catch (err) {
        alert("Error al procesar el archivo:\n" + err.message);
        console.error(err);
      }
    };

    reader.onerror = function () {
      alert("No se pudo leer el archivo. Intente de nuevo.");
    };

    reader.readAsText(currentFile, "UTF-8");
  });

  // ─── Comparar ───────────────────────────────────────────────────────────────

  $("#btnComparar").on("click", function () {
    if (!methods.length) {
      alert("Primero cargue un archivo XML.");
      return;
    }

    const labelA = $("#metodoOutput").val();
    const labelB = $("#metodoInput").val();

    const methodA = methods.find((m) => m.label === labelA);
    const methodB = methods.find((m) => m.label === labelB);

    if (!methodA || !methodB) {
      alert("No se encontraron los métodos seleccionados.");
      return;
    }

    if (labelA === labelB) {
      alert("Seleccione métodos distintos para comparar.");
      return;
    }

    // Verificar que A tenga outputs y B tenga inputs
    if (!methodA.outputs.length && !methodB.inputs.length) {
      $("#tbodyResultados").html(`
        <tr>
          <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
            El método A no tiene <em>returnValues</em> y el método B no tiene <em>parameters</em>.
            No hay nada que comparar.
          </td>
        </tr>`);
      currentResults = [];
      return;
    }

    currentResults = compareMethodOutputVsInput(methodA, methodB);
    activeFilter = "todos";
    setActiveFilterButton("todos");
    renderTable(currentResults, "todos");
  });

  // ─── Filtros ─────────────────────────────────────────────────────────────────

  $("[data-filter]").on("click", function () {
    if (!currentResults.length) return;

    activeFilter = $(this).data("filter");
    setActiveFilterButton(activeFilter);
    renderTable(currentResults, activeFilter);
  });

  function setActiveFilterButton(filter) {
    // Resetear todos
    $("[data-filter]")
      .removeClass("bg-white text-primary shadow-sm")
      .addClass("text-on-surface-variant hover:bg-white/50");

    // Activar el seleccionado
    $(`[data-filter="${filter}"]`)
      .removeClass("text-on-surface-variant hover:bg-white/50")
      .addClass("bg-white text-primary shadow-sm");
  }

  // ─── Exportar ────────────────────────────────────────────────────────────────

  $("#btnExportarExcel").on("click", function () {
    if (!currentResults.length) {
      alert(
        "No hay resultados para exportar. Realice una comparación primero.",
      );
      return;
    }

    const labelA = $("#metodoOutput").val();
    const labelB = $("#metodoInput").val();

    exportToExcel(currentResults, labelA, labelB);
  });

  // ─── Limpiar ─────────────────────────────────────────────────────────────────

  // El botón "Limpiar" no tiene ID en el HTML, seleccionamos por contexto
  // (es el primer botón sin ID en la card de selección de métodos)
  $('button:contains("Limpiar")').on("click", function () {
    currentResults = [];
    activeFilter = "todos";
    setActiveFilterButton("todos");

    $("#tbodyResultados").html(`
      <tr>
        <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
          Seleccione Método A y Método B y presione Comparar.
        </td>
      </tr>`);

    updateFooter(0, 0);
  });

  // ─── Estado inicial ───────────────────────────────────────────────────────────
  $("#metodoOutput, #metodoInput")
    .empty()
    .append("<option>— Cargue un archivo —</option>");

  $("#tbodyResultados").html(`
    <tr>
      <td colspan="5" class="px-6 py-12 text-center text-outline text-sm">
        Cargue un archivo XML para comenzar.
      </td>
    </tr>`);
});
