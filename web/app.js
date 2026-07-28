(() => {
  "use strict";

  const DATABASE_URL = "../data/kb.sqlite";
  const COMPRESSED_DATABASE_URL = "../data/kb.sqlite.gz";
  const RESULT_LIMIT = 200;
  const DEBOUNCE_MS = 250;
  const SEARCH_COLUMNS = [
    "crop_name",
    "pest_name",
    "pesti_kor_name",
    "brand_name",
    "comp_name",
    "eng_name",
    "ingredient_name",
  ];
  // use_name은 '살균'·'살충'·'제초' 외에 복합제 '균충'(살균+살충)·'충초'(살충+제초)도
  // 쓴다. 한 글자로 매칭해야 복합제가 해당 용도 필터에 모두 잡힌다.
  const USAGE_TYPE_VALUES = {
    살균제: "균",
    살충제: "충",
    제초제: "초",
  };
  const PRIMARY_USAGE_TYPES = Object.keys(USAGE_TYPE_VALUES);
  const RESULT_COLUMNS = [
    { key: "pesti_kor_name", label: "품목명", className: "cell-primary" },
    { key: "brand_name", label: "상표명", className: "cell-accent" },
    { key: "comp_name", label: "회사" },
    { key: "crop_name", label: "작물", className: "cell-primary" },
    { key: "pest_name", label: "병해충" },
    { key: "dilut_unit", label: "희석배수" },
    { key: "pesti_use", label: "사용적기" },
    { key: "safety", label: "안전사용기준(시기·횟수)" },
    { key: "status", label: "등록상태" },
  ];

  const elements = {
    searchForm: document.querySelector("#search-form"),
    searchInput: document.querySelector("#search-input"),
    usageFilters: document.querySelector("#usage-filters"),
    resultCount: document.querySelector("#result-count"),
    resultLimitNote: document.querySelector("#result-limit-note"),
    resultsRegion: document.querySelector("#results-region"),
    resultsBody: document.querySelector("#results-body"),
    tableWrap: document.querySelector("#table-wrap"),
    loadingState: document.querySelector("#loading-state"),
    emptyState: document.querySelector("#empty-state"),
    missingState: document.querySelector("#missing-state"),
    errorState: document.querySelector("#error-state"),
    errorDetail: document.querySelector("#error-detail"),
    statusLight: document.querySelector("#status-light"),
    databaseStatus: document.querySelector("#database-status"),
    databaseDetail: document.querySelector("#database-detail"),
  };

  let database = null;
  let debounceTimer = null;
  // 등록취소 목록은 v_usage에 없다. 400건뿐이라 초기화 때 키로 올려두고 대조한다.
  let revokedKeys = new Set();

  function revokedKey(row) {
    return [row.pesti_kor_name, row.brand_name, row.comp_name].join("␟");
  }

  function escapeLike(value) {
    return value.replace(/[!%_]/gu, "!$&");
  }

  function buildWhereClause(searchValue, usageType) {
    const clauses = [];
    const parameters = [];
    const query = searchValue.trim();

    for (const term of query.split(/\s+/u).filter(Boolean)) {
      clauses.push(
        `(${SEARCH_COLUMNS.map(
          (column) => `COALESCE(${column}, '') LIKE ? ESCAPE '!'`,
        ).join(" OR ")})`,
      );
      const pattern = `%${escapeLike(term)}%`;
      parameters.push(...SEARCH_COLUMNS.map(() => pattern));
    }

    if (PRIMARY_USAGE_TYPES.includes(usageType)) {
      clauses.push("COALESCE(use_name, '') LIKE ? ESCAPE '!'");
      parameters.push(`%${escapeLike(USAGE_TYPE_VALUES[usageType])}%`);
    } else if (usageType === "기타") {
      clauses.push(
        `(${PRIMARY_USAGE_TYPES.map(
          () => "COALESCE(use_name, '') NOT LIKE ? ESCAPE '!'",
        ).join(" AND ")})`,
      );
      parameters.push(
        ...PRIMARY_USAGE_TYPES.map(
          (type) => `%${escapeLike(USAGE_TYPE_VALUES[type])}%`,
        ),
      );
    }

    return {
      sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
      parameters,
    };
  }

  function executeQuery(sql, parameters) {
    const statement = database.prepare(sql);
    const rows = [];

    try {
      if (parameters.length) {
        statement.bind(parameters);
      }
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
    } finally {
      statement.free();
    }

    return rows;
  }

  function getSelectedUsageType() {
    return (
      elements.usageFilters.querySelector('input[name="usage"]:checked')
        ?.value ?? "전체"
    );
  }

  function formatValue(value) {
    if (value === null || value === undefined) {
      return "—";
    }
    return String(value).trim() || "—";
  }

  function formatSafety(row) {
    const values = [row.use_suittime, row.use_num]
      .map((value) =>
        value === null || value === undefined ? "" : String(value).trim(),
      )
      .filter(Boolean);
    return values.length ? values.join(" · ") : "—";
  }

  function createCell(label, value, className = "") {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    cell.textContent = formatValue(value);
    if (className) {
      cell.classList.add(className);
    }
    return cell;
  }

  function renderRows(rows) {
    const fragment = document.createDocumentFragment();

    for (const row of rows) {
      const tableRow = document.createElement("tr");
      const revoked = revokedKeys.has(revokedKey(row));
      const view = {
        ...row,
        safety: formatSafety(row),
        status: revoked ? "등록취소" : "등록",
      };

      for (const column of RESULT_COLUMNS) {
        const cell = createCell(column.label, view[column.key], column.className);
        if (column.key === "status" && revoked) {
          cell.classList.add("cell-revoked");
        }
        tableRow.append(cell);
      }
      fragment.append(tableRow);
    }

    elements.resultsBody.replaceChildren(fragment);
  }

  function showResultState(state) {
    elements.loadingState.hidden = state !== "loading";
    elements.emptyState.hidden = state !== "empty";
    elements.missingState.hidden = state !== "missing";
    elements.errorState.hidden = state !== "error";
    elements.tableWrap.hidden = state !== "ready";
    elements.resultsRegion.setAttribute(
      "aria-busy",
      state === "loading" ? "true" : "false",
    );
  }

  function updateDatabaseStatus(state, label, detail) {
    elements.statusLight.dataset.state = state;
    elements.databaseStatus.textContent = label;
    elements.databaseDetail.textContent = detail;
  }

  function setControlsEnabled(enabled) {
    elements.searchInput.disabled = !enabled;
    elements.usageFilters.disabled = !enabled;
  }

  function renderResultCount(total) {
    elements.resultCount.textContent = `${total.toLocaleString("ko-KR")}건`;
    elements.resultLimitNote.textContent =
      total > RESULT_LIMIT ? `최대 ${RESULT_LIMIT}건 표시` : "전체 결과 표시";
  }

  function runSearch() {
    if (!database) {
      return;
    }

    const { sql: whereSql, parameters } = buildWhereClause(
      elements.searchInput.value,
      getSelectedUsageType(),
    );

    try {
      const distinctResultsSql = `SELECT DISTINCT
        pesti_kor_name,
        brand_name,
        comp_name,
        crop_name,
        pest_name,
        dilut_unit,
        pesti_use,
        use_suittime,
        use_num
      FROM v_usage
      ${whereSql}`;
      const countRows = executeQuery(
        `SELECT COUNT(*) AS total FROM (${distinctResultsSql})`,
        parameters,
      );
      const total = Number(countRows[0]?.total ?? 0);
      const rows = executeQuery(
        `${distinctResultsSql}
        ORDER BY
          COALESCE(pesti_kor_name, '') COLLATE NOCASE,
          COALESCE(brand_name, '') COLLATE NOCASE,
          COALESCE(crop_name, '') COLLATE NOCASE,
          COALESCE(pest_name, '') COLLATE NOCASE
        LIMIT ${RESULT_LIMIT}`,
        parameters,
      );

      renderResultCount(total);
      renderRows(rows);
      showResultState(rows.length ? "ready" : "empty");
    } catch (error) {
      showFatalError(error);
    }
  }

  function scheduleSearch() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(runSearch, DEBOUNCE_MS);
  }

  function showDataMissing() {
    setControlsEnabled(false);
    elements.resultCount.textContent = "0건";
    elements.resultLimitNote.textContent = "데이터 생성 필요";
    updateDatabaseStatus("error", "DATABASE EMPTY", "KB.SQLITE NOT FOUND");
    showResultState("missing");
  }

  function showFatalError(error) {
    setControlsEnabled(false);
    elements.resultCount.textContent = "—";
    elements.resultLimitNote.textContent = "연결 실패";
    elements.errorDetail.textContent =
      error instanceof Error
        ? error.message
        : "파일 형식과 정적 서버 경로를 확인해 주세요.";
    updateDatabaseStatus("error", "DATABASE ERROR", "CHECK LOCAL FILE");
    showResultState("error");
    console.error("NONGYAK KB initialization failed:", error);
  }

  // 원본 kb.sqlite는 91.5MB지만 gzip 압축본은 13.4MB다. 압축본이 있으면 그것을
  // 받아 브라우저에서 풀고, 없거나 해제에 실패하면 원본을 그대로 내려받는다.
  async function fetchDatabaseBuffer() {
    if (typeof DecompressionStream === "function") {
      try {
        const response = await fetch(COMPRESSED_DATABASE_URL);
        if (response.ok && response.body) {
          // 서버가 Content-Encoding으로 이미 풀어 보냈다면 다시 풀지 않는다
          const decoded = /gzip/iu.test(
            response.headers.get("content-encoding") ?? "",
          );
          const stream = decoded
            ? response.body
            : response.body.pipeThrough(new DecompressionStream("gzip"));
          const buffer = await new Response(stream).arrayBuffer();
          if (buffer.byteLength) {
            return buffer;
          }
        }
      } catch (error) {
        console.warn("압축 데이터베이스를 사용할 수 없어 원본을 내려받습니다:", error);
      }
    }

    const response = await fetch(DATABASE_URL);
    return response.ok ? await response.arrayBuffer() : null;
  }

  async function initializeDatabase() {
    try {
      const fileBuffer = await fetchDatabaseBuffer();
      if (!fileBuffer || !fileBuffer.byteLength) {
        showDataMissing();
        return;
      }

      const SQL = await window.initSqlJs({
        locateFile: (file) => new URL(`./vendor/${file}`, document.baseURI).href,
      });
      database = new SQL.Database(new Uint8Array(fileBuffer));
      revokedKeys = new Set(
        executeQuery(
          `SELECT pesti_kor_name, brand_name, comp_name
           FROM revoked_products
           WHERE brand_name IS NOT NULL AND comp_name IS NOT NULL`,
          [],
        ).map(revokedKey),
      );

      setControlsEnabled(true);
      updateDatabaseStatus("ready", "DATABASE READY", "LOCAL SQLITE / WASM");
      runSearch();
      elements.searchInput.focus({ preventScroll: true });
    } catch (error) {
      showFatalError(error);
    }
  }

  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(debounceTimer);
    runSearch();
  });
  elements.searchInput.addEventListener("input", scheduleSearch);
  elements.usageFilters.addEventListener("change", () => {
    window.clearTimeout(debounceTimer);
    runSearch();
  });
  window.addEventListener("pagehide", () => {
    database?.close();
    database = null;
  });

  initializeDatabase();
})();
