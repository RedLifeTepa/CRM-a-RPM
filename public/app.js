const state = {
  token: localStorage.getItem("flotilla_token") || "",
  user: null,
  settings: null,
  page: "dashboard",
  vehicles: [],
  drivers: [],
  workshops: [],
  maintenance: [],
  operations: [],
  vehicleTypes: [],
  currentVehicle: null,
  currentOperation: null,
  detailTab: "summary",
  alertCount: 0,
  searchTimer: null
};

const appRoot = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");

const pageMeta = {
  dashboard: ["Centro de control", "Resumen operativo"],
  operations: ["Operaciones", "Salidas, retornos y revisión"],
  vehicles: ["Vehículos", "Inventario de unidades"],
  drivers: ["Choferes", "Personal autorizado"],
  maintenance: ["Mantenimiento", "Órdenes y servicios"],
  workshops: ["Talleres", "Directorio de proveedores"],
  reports: ["Reportes", "Exportación y análisis"],
  audit: ["Auditoría", "Trazabilidad del sistema"],
  settings: ["Configuración", "Empresa y seguridad"]
};

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: "DB" },
  { id: "operations", label: "Operaciones", icon: "OP" },
  { id: "vehicles", label: "Vehículos", icon: "VH" },
  { id: "drivers", label: "Choferes", icon: "CH" },
  { id: "maintenance", label: "Mantenimiento", icon: "MT" },
  { id: "workshops", label: "Talleres", icon: "TL" },
  { id: "reports", label: "Reportes", icon: "RP" },
  { id: "audit", label: "Auditoría", icon: "AU", roles: ["admin", "gestor", "auditor"] },
  { id: "settings", label: "Configuración", icon: "CF", roles: ["admin", "gestor", "capturista", "chofer", "taller", "auditor"] }
];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "NF";
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-MX").format(Number(value || 0));
}

function formatDate(value, withTime = false) {
  if (!value) return "Sin fecha";
  const date = new Date(value.includes?.("T") ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function dateInputValue(value) {
  return value ? String(value).slice(0, 10) : "";
}

function localDateTime() {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
}

function statusText(status = "") {
  return ({
    disponible: "Disponible",
    reservado: "Reservado",
    en_uso: "En uso",
    pendiente_revision: "Pendiente de revisión",
    fuera_servicio: "Fuera de servicio",
    taller: "En taller",
    inactivo: "Inactivo",
    abierta: "Abierta",
    en_proceso: "En proceso",
    completada: "Completada",
    cancelada: "Cancelada",
    reservada: "Reservada",
    activa: "Activa",
    cerrada: "Cerrada",
    activo: "Activo",
    alta: "Prioridad alta",
    media: "Prioridad media"
  })[status] || status.replaceAll("_", " ");
}

function badge(status) {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(statusText(status))}</span>`;
}

function roleText(role) {
  return ({
    admin: "Administrador",
    gestor: "Gestor de flota",
    taller: "Taller",
    chofer: "Chofer",
    capturista: "Capturista",
    auditor: "Consulta / auditoría"
  })[role] || role;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    logout(false);
    throw new Error("Tu sesión terminó. Ingresa nuevamente.");
  }
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || payload.message || "No fue posible completar la operación");
  return payload;
}

async function apiDownload(url, filename, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.token}`);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "No fue posible descargar el archivo" }));
    throw new Error(error.error);
  }
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRoot.replaceChildren(element);
  setTimeout(() => element.remove(), 3400);
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle("loading-button", loading);
}

function openModal(title, subtitle, body, wide = false) {
  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="overlay-close">
      <section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-header">
          <div>
            <h2 id="modal-title">${escapeHtml(title)}</h2>
            ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
          </div>
          <button class="modal-close" type="button" data-action="close-modal" aria-label="Cerrar">×</button>
        </header>
        <div class="modal-body">${body}</div>
      </section>
    </div>`;
  setTimeout(() => modalRoot.querySelector("input, select, textarea, button")?.focus(), 50);
}

function closeModal() {
  modalRoot.innerHTML = "";
  state.currentVehicle = null;
}

function emptyState(title, description, icon = "—") {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </div>`;
}

function canManage() {
  return ["admin", "gestor"].includes(state.user?.role);
}

function canOperate() {
  return ["admin", "gestor", "capturista"].includes(state.user?.role);
}

function canCapture() {
  return ["admin", "gestor", "capturista", "chofer"].includes(state.user?.role);
}

function operationTypeText(type = "") {
  return ({
    comision: "Comisión",
    uso_interno: "Uso interno",
    transporte_turistico: "Transporte turístico",
    renta: "Renta",
    resguardo: "Resguardo",
    traslado_taller: "Traslado a taller"
  })[type] || type.replaceAll("_", " ");
}

function renderLogin() {
  document.body.classList.remove("menu-open");
  appRoot.innerHTML = `
    <section class="login-screen">
      <div class="login-panel">
        <div class="login-card">
          <div class="login-brand">
            <div class="brand-mark">NF</div>
            <div><strong>NovaFlota</strong><span>Inteligencia vehicular</span></div>
          </div>
          <span class="eyebrow">Acceso seguro</span>
          <h1>Tu flotilla, bajo control.</h1>
          <p>Administra vehículos, choferes, mantenimientos, kilometraje y alertas desde un solo lugar.</p>
          <form class="login-form" data-form="login">
            <div class="form-group">
              <label for="login-identifier">Usuario o correo</label>
              <input id="login-identifier" name="identifier" value="admin" autocomplete="username" required />
            </div>
            <div class="form-group">
              <label for="login-password">Contraseña</label>
              <input id="login-password" name="password" type="password" value="admin" autocomplete="current-password" required />
            </div>
            <button class="btn btn-primary btn-block" type="submit">Ingresar al sistema</button>
          </form>
          <div class="login-help">
            <span><strong>Cuenta inicial:</strong> admin</span>
            <span><strong>Contraseña:</strong> admin</span>
          </div>
        </div>
      </div>
      <div class="login-visual" aria-hidden="true">
        <div class="visual-grid"></div>
        <div class="visual-content">
          <span class="eyebrow">Operación conectada</span>
          <h2>Decisiones claras. Rutas seguras.</h2>
          <p>Una vista operativa para anticipar mantenimientos, reducir tiempos muertos y conservar el historial de cada unidad.</p>
          <div class="visual-stats">
            <div class="visual-stat"><strong>360°</strong><span>Visión de la flota</span></div>
            <div class="visual-stat"><strong>24/7</strong><span>Alertas operativas</span></div>
            <div class="visual-stat"><strong>1 clic</strong><span>Reportes listos</span></div>
          </div>
        </div>
      </div>
    </section>`;
}

function renderShell() {
  const availableNav = navItems.filter((item) => !item.roles || item.roles.includes(state.user.role));
  const company = state.settings?.companyName || "Control de Flotilla";
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <div class="brand-mark">${escapeHtml(initials(company))}</div>
          <div><strong>${escapeHtml(company)}</strong><span>Gestión inteligente</span></div>
        </div>
        <p class="nav-label">Operación</p>
        <nav class="sidebar-nav" aria-label="Navegación principal">
          ${availableNav.map((item) => `
            <button class="nav-item ${state.page === item.id ? "active" : ""}" type="button" data-page="${item.id}">
              <span class="nav-icon">${item.icon}</span>${item.label}
            </button>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-card">
            <div class="avatar">${escapeHtml(initials(state.user.name))}</div>
            <div><strong>${escapeHtml(state.user.name)}</strong><span>${escapeHtml(roleText(state.user.role))}</span></div>
            <button class="logout-button" type="button" data-action="logout" aria-label="Cerrar sesión">↗</button>
          </div>
        </div>
      </aside>
      <div class="mobile-backdrop" data-action="close-menu"></div>
      <section class="main-shell">
        <header class="topbar">
          <div class="topbar-left">
            <button class="mobile-menu" type="button" data-action="open-menu" aria-label="Abrir menú">☰</button>
            <div class="topbar-title">
              <small id="topbar-subtitle">${escapeHtml(pageMeta[state.page]?.[1] || "")}</small>
              <strong id="topbar-title">${escapeHtml(pageMeta[state.page]?.[0] || "")}</strong>
            </div>
          </div>
          <div class="topbar-actions">
            <button class="notification-chip" type="button" data-page="dashboard">
              <span class="notification-dot"></span>
              <span id="alert-count">${state.alertCount} alertas activas</span>
            </button>
          </div>
        </header>
        <div class="page-content" id="page-content"></div>
      </section>
    </div>`;
}

function updateShellMeta() {
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
  const meta = pageMeta[state.page] || ["Control de Flotilla", ""];
  const title = document.querySelector("#topbar-title");
  const subtitle = document.querySelector("#topbar-subtitle");
  if (title) title.textContent = meta[0];
  if (subtitle) subtitle.textContent = meta[1];
}

function loadingPage() {
  const root = document.querySelector("#page-content");
  if (root) root.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">Cargando</span><h1>Preparando información…</h1></div></div>
    <div class="metric-grid">${Array.from({ length: 4 }, () => '<div class="skeleton"></div>').join("")}</div>`;
}

async function navigate(page) {
  if (!pageMeta[page]) return;
  state.page = page;
  document.body.classList.remove("menu-open");
  updateShellMeta();
  loadingPage();
  try {
    if (page === "dashboard") await renderDashboard();
    if (page === "operations") await renderOperations();
    if (page === "vehicles") await renderVehicles();
    if (page === "drivers") await renderDrivers();
    if (page === "maintenance") await renderMaintenance();
    if (page === "workshops") await renderWorkshops();
    if (page === "reports") renderReports();
    if (page === "audit") await renderAudit();
    if (page === "settings") await renderSettings();
  } catch (error) {
    const root = document.querySelector("#page-content");
    if (root) root.innerHTML = emptyState("No fue posible cargar esta sección", error.message, "!");
    toast(error.message, "error");
  }
}

async function renderDashboard() {
  const data = await api("/api/dashboard");
  state.alertCount = data.metrics.activeAlerts;
  const count = document.querySelector("#alert-count");
  if (count) count.textContent = `${state.alertCount} alertas activas`;
  const totalVehicles = Math.max(1, data.metrics.totalVehicles);
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div>
        <span class="eyebrow">Mesa de control</span>
        <h1>Buenos días, ${escapeHtml(state.user.name.split(" ")[0])}.</h1>
        <p>Todo lo pendiente de la flotilla, conectado con la operación que lo originó.</p>
      </div>
      <div class="heading-actions">
        <button class="btn btn-secondary" type="button" data-action="quick-report">Exportar reporte</button>
        ${canOperate() ? '<button class="btn btn-primary" type="button" data-action="add-operation">+ Nueva operación</button>' : ""}
      </div>
    </div>
    <section class="hero-panel">
      <div class="hero-copy">
        <span class="eyebrow">Operación al momento</span>
        <h2>${data.metrics.availableVehicles} unidades listas para salir.</h2>
        <p>${data.metrics.openOperations} operaciones abiertas · ${data.metrics.pendingReturns} retornos por revisar · ${data.metrics.workshopVehicles} unidades en taller.</p>
        <div class="heading-actions compact-actions">
          <button class="btn btn-light" type="button" data-page="operations">Abrir centro operativo</button>
          <button class="btn btn-ghost-light" type="button" data-page="vehicles">Ver disponibilidad</button>
        </div>
      </div>
      <div class="hero-availability">
        ${data.availability.map((item) => `
          <div class="availability-row">
            <span>${escapeHtml(statusText(item.status))}</span>
            <div class="progress"><span style="width:${Math.round((item.total / totalVehicles) * 100)}%"></span></div>
            <strong>${item.total}</strong>
          </div>`).join("")}
      </div>
    </section>
    <section class="metric-grid">
      <article class="metric-card">
        <span class="metric-label">Unidades ocupadas</span>
        <strong class="metric-value">${data.metrics.occupiedVehicles}</strong>
        <span class="metric-note">${data.metrics.reservedVehicles} reservadas para próximas salidas</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Retornos pendientes</span>
        <strong class="metric-value">${data.metrics.pendingReturns}</strong>
        <span class="metric-note">${data.metrics.openCustodies} resguardos todavía abiertos</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Costo operativo del mes</span>
        <strong class="metric-value">${formatMoney(data.metrics.monthlyOperationCost)}</strong>
        <span class="metric-note">${formatMoney(data.metrics.monthlyIncome)} de ingresos ligados</span>
      </article>
      <article class="metric-card">
        <span class="metric-label">Alertas activas</span>
        <strong class="metric-value">${data.metrics.activeAlerts}</strong>
        <span class="metric-note">seguros, licencias y servicios</span>
      </article>
    </section>
    <article class="panel operation-focus">
      <header class="panel-header">
        <div><h2>Siguiente acción</h2><p>Operaciones que necesitan salida, retorno o revisión</p></div>
        <button class="btn btn-ghost" type="button" data-page="operations">Ver todas</button>
      </header>
      <div class="panel-body">
        ${data.tasks.length ? detailRows(data.tasks, [
          { label: "Folio", render: (item) => `<button class="table-link" data-action="operation-detail" data-id="${item.id}">${escapeHtml(item.folio)}</button>` },
          { label: "Unidad", key: "plate" },
          { label: "Responsable", key: "driverName" },
          { label: "Destino", key: "destination" },
          { label: "Estado", render: (item) => badge(item.status) },
          { label: "Acción", render: (item) => operationPrimaryAction(item) }
        ]) : emptyState("Sin tareas operativas", "No hay salidas, retornos o revisiones pendientes.", "✓")}
      </div>
    </article>
    <section class="dashboard-grid">
      <article class="panel">
        <header class="panel-header"><div><h2>Alertas prioritarias</h2><p>Vencimientos y servicios próximos</p></div>${badge(data.alerts.some((a) => a.severity === "alta") ? "alta" : "media")}</header>
        <div class="panel-body alert-list">
          ${data.alerts.length ? data.alerts.map((alert) => `
            <div class="alert-item severity-${escapeHtml(alert.severity)}">
              <div class="alert-icon">!</div>
              <div><strong>${escapeHtml(alert.message)}</strong><span>${alert.dueDate ? `Fecha: ${formatDate(alert.dueDate)}` : `Al llegar a ${formatNumber(alert.dueKm)} km`}</span></div>
              ${badge(alert.severity)}
            </div>`).join("") : emptyState("Todo está en orden", "No hay alertas activas en este momento.", "✓")}
        </div>
      </article>
      <article class="panel">
        <header class="panel-header"><div><h2>Actividad reciente</h2><p>Últimos movimientos del sistema</p></div></header>
        <div class="panel-body activity-list">
          ${data.activity.length ? data.activity.map((item) => `
            <div class="activity-item">
              <span class="activity-dot"></span>
              <div><strong>${escapeHtml(item.userName || "Sistema")} · ${escapeHtml(item.action)}</strong><span>${escapeHtml(item.entityType)} ${item.entityId || ""}</span></div>
              <span>${formatDate(item.createdAt, true)}</span>
            </div>`).join("") : emptyState("Sin actividad", "Los cambios aparecerán aquí.", "AU")}
        </div>
      </article>
    </section>`;
}

function operationPrimaryAction(operation) {
  if (operation.status === "reservada" && canCapture()) {
    return `<button class="btn btn-small btn-primary" data-action="start-operation" data-id="${operation.id}">Registrar salida</button>`;
  }
  if (operation.status === "activa" && canCapture()) {
    return `<button class="btn btn-small btn-success" data-action="return-operation" data-id="${operation.id}">Registrar retorno</button>`;
  }
  if (operation.status === "pendiente_revision" && canManage()) {
    return `<button class="btn btn-small btn-warning" data-action="review-operation" data-id="${operation.id}">Revisar y liberar</button>`;
  }
  return `<button class="btn btn-small btn-ghost" data-action="operation-detail" data-id="${operation.id}">Ver expediente</button>`;
}

async function renderOperations(status = "", query = "") {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (query) params.set("q", query);
  const [operations] = await Promise.all([api(`/api/operations?${params}`), ensureCatalogs()]);
  state.operations = operations;
  const activeCount = operations.filter((item) => item.status === "activa").length;
  const reviewCount = operations.filter((item) => item.status === "pendiente_revision").length;
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div>
        <span class="eyebrow">Flujo único con folio</span>
        <h1>Centro de operaciones</h1>
        <p>Cada salida conecta unidad, responsable, kilometraje, combustible, incidencias, costos y retorno.</p>
      </div>
      <div class="heading-actions">
        ${canOperate() ? '<button class="btn btn-primary" type="button" data-action="add-operation">+ Nueva operación</button>' : ""}
      </div>
    </div>
    <section class="operation-summary">
      <article><span>Activas ahora</span><strong>${activeCount}</strong></article>
      <article><span>Pendientes de revisión</span><strong>${reviewCount}</strong></article>
      <article><span>Resultado acumulado</span><strong>${formatMoney(operations.reduce((sum, item) => sum + Number(item.profit || 0), 0))}</strong></article>
    </section>
    <div class="toolbar">
      <div class="filters">
        <div class="search-wrap"><input id="operation-search" value="${escapeHtml(query)}" placeholder="Buscar folio, placa, cliente o destino…" /></div>
        <select id="operation-status" class="field" aria-label="Filtrar operaciones">
          <option value="">Todos los estados</option>
          ${["reservada", "activa", "pendiente_revision", "cerrada", "cancelada"].map((value) => `<option value="${value}" ${status === value ? "selected" : ""}>${statusText(value)}</option>`).join("")}
        </select>
      </div>
      <span class="badge badge-activo">${operations.length} operaciones</span>
    </div>
    <section class="operation-list">
      ${operations.length ? operations.map((operation) => `
        <article class="operation-card status-edge-${escapeHtml(operation.status)}">
          <div class="operation-card-main">
            <div class="operation-folio">
              <span>${escapeHtml(operation.folio)}</span>
              ${badge(operation.status)}
            </div>
            <h3>${escapeHtml(operation.plate)} · ${escapeHtml(operationTypeText(operation.operationType))}</h3>
            <p>${escapeHtml(operation.purpose)}${operation.destination ? ` · ${escapeHtml(operation.destination)}` : ""}</p>
            <div class="operation-meta">
              <span><small>Responsable</small>${escapeHtml(operation.driverName || operation.responsibleName || operation.clientName || "Sin asignar")}</span>
              <span><small>Programada</small>${formatDate(operation.plannedStart, true)}</span>
              <span><small>Recorrido</small>${formatNumber(operation.distanceKm)} km</span>
              <span><small>Costo / ingreso</small>${formatMoney(operation.totalCost)} / ${formatMoney(operation.income)}</span>
            </div>
          </div>
          <div class="operation-card-actions">
            ${operationPrimaryAction(operation)}
            <button class="btn btn-small btn-ghost" data-action="operation-detail" data-id="${operation.id}">Expediente</button>
            ${canManage() && operation.status !== "cancelada" ? `<button class="btn btn-small btn-ghost" data-action="correct-operation" data-id="${operation.id}">Corregir</button>` : ""}
          </div>
        </article>`).join("") : emptyState("No encontramos operaciones", "Ajusta el filtro o crea la primera operación.", "OP")}
    </section>`;
}

async function openOperationForm(preselectedVehicleId = null) {
  await ensureCatalogs();
  if (!state.vehicles.length) state.vehicles = await api("/api/vehicles");
  const available = state.vehicles.filter((vehicle) => vehicle.status === "disponible");
  openModal("Nueva operación", "Un solo folio conectará todo el movimiento", `
    <form data-form="operation">
      <div class="form-section-title"><span>1</span><div><strong>Tipo y unidad</strong><small>El sistema validará disponibilidad y modalidad.</small></div></div>
      <div class="form-grid">
        <div class="form-group"><label>Tipo de operación *</label><select name="operationType" required>
          <option value="comision">Comisión</option><option value="uso_interno">Uso interno</option>
          <option value="transporte_turistico">Transporte turístico</option><option value="renta">Renta</option>
          <option value="resguardo">Resguardo</option><option value="traslado_taller">Traslado a taller</option>
        </select></div>
        <div class="form-group"><label>Vehículo disponible *</label><select name="vehicleId" required>
          <option value="">Seleccionar unidad</option>
          ${available.map((vehicle) => `<option value="${vehicle.id}" ${Number(preselectedVehicleId) === vehicle.id ? "selected" : ""}>${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)} · ${formatNumber(vehicle.currentMileage)} km</option>`).join("")}
        </select></div>
      </div>
      ${available.length ? "" : '<div class="inline-warning">No hay unidades disponibles. Revisa retornos pendientes, reservas o mantenimientos.</div>'}
      <div class="form-section-title"><span>2</span><div><strong>Asignación</strong><small>Elige chofer o identifica al responsable/cliente.</small></div></div>
      <div class="form-grid">
        <div class="form-group"><label>Chofer</label><select name="driverId"><option value="">Sin chofer</option>${state.drivers.filter((item) => item.active).map((driver) => `<option value="${driver.id}" ${driver.activeOperationFolio ? "disabled" : ""}>${escapeHtml(driver.name)} · ${driver.activeOperationFolio ? `ocupado en ${escapeHtml(driver.activeOperationFolio)}` : `licencia ${formatDate(driver.licenseExpiry)}`}</option>`).join("")}</select></div>
        <div class="form-group"><label>Responsable</label><input name="responsibleName" placeholder="Persona que recibe la unidad" /></div>
        <div class="form-group"><label>Cliente</label><input name="clientName" /></div>
        <div class="form-group"><label>Dependencia / área</label><input name="dependencyName" /></div>
      </div>
      <div class="form-section-title"><span>3</span><div><strong>Programa y propósito</strong><small>Define cuándo, para qué y hacia dónde.</small></div></div>
      <div class="form-grid">
        <div class="form-group"><label>Salida programada *</label><input type="datetime-local" name="plannedStart" value="${localDateTime()}" required /></div>
        <div class="form-group"><label>Retorno programado</label><input type="datetime-local" name="plannedEnd" /></div>
        <div class="form-group full"><label>Motivo *</label><input name="purpose" required placeholder="Describe el servicio o uso de la unidad" /></div>
        <div class="form-group full"><label>Destino</label><input name="destination" /></div>
        <div class="form-group"><label>Ingreso previsto</label><input name="income" type="number" min="0" step="0.01" value="0" /></div>
        <div class="form-group"><label>Costo cotizado</label><input name="quotedCost" type="number" min="0" step="0.01" value="0" /></div>
        <div class="form-group full"><label>Notas</label><textarea name="notes" rows="2"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit" ${available.length ? "" : "disabled"}>Crear folio y reservar</button></div>
    </form>`, true);
}

async function openOperationDetail(id) {
  const operation = await api(`/api/operations/${id}`);
  state.currentOperation = operation;
  const result = Number(operation.income || 0) - Number(operation.totalCost || 0);
  openModal(`${operation.folio}`, `${operationTypeText(operation.operationType)} · ${operation.plate}`, `
    <div class="operation-detail-hero">
      <div><span class="eyebrow">Expediente conectado</span><h3>${escapeHtml(operation.purpose)}</h3><p>${escapeHtml(operation.destination || "Sin destino capturado")}</p></div>
      ${badge(operation.status)}
    </div>
    <div class="summary-grid">
      <div class="summary-box"><span>Vehículo</span><strong>${escapeHtml(operation.plate)} · ${escapeHtml(operation.brand)} ${escapeHtml(operation.model)}</strong></div>
      <div class="summary-box"><span>Responsable</span><strong>${escapeHtml(operation.driverName || operation.responsibleName || operation.clientName || "Sin asignar")}</strong></div>
      <div class="summary-box"><span>Salida</span><strong>${formatDate(operation.departureAt || operation.plannedStart, true)}</strong></div>
      <div class="summary-box"><span>Retorno</span><strong>${formatDate(operation.returnedAt || operation.plannedEnd, true)}</strong></div>
      <div class="summary-box"><span>Kilómetros</span><strong>${operation.finalKm == null ? `${formatNumber(operation.initialKm)} iniciales` : `${formatNumber(operation.finalKm - operation.initialKm)} recorridos`}</strong></div>
      <div class="summary-box"><span>Combustible</span><strong>${escapeHtml(operation.fuelLevelOut || "—")} → ${escapeHtml(operation.fuelLevelIn || "—")}</strong></div>
      <div class="summary-box"><span>Costo real</span><strong>${formatMoney(operation.totalCost)}</strong></div>
      <div class="summary-box"><span>Resultado</span><strong class="${result < 0 ? "negative" : "positive"}">${formatMoney(result)}</strong></div>
    </div>
    <div class="connected-strip">
      <span><strong>${operation.fuelVouchers.length}</strong> cargas</span>
      <span><strong>${operation.expenses.length}</strong> gastos</span>
      <span><strong>${operation.incidents.length}</strong> incidentes</span>
      <span><strong>${operation.documents.length}</strong> documentos</span>
    </div>
    ${operation.reviewNotes ? `<div class="inline-note"><strong>Revisión:</strong> ${escapeHtml(operation.reviewNotes)}</div>` : ""}
    <div class="form-actions wrap-actions">
      ${operationPrimaryAction(operation)}
      ${canCapture() && ["activa", "pendiente_revision"].includes(operation.status) ? `<button class="btn btn-secondary" data-action="add-operation-expense" data-id="${operation.id}">+ Gasto</button>` : ""}
      <button class="btn btn-secondary" data-action="operation-ticket" data-id="${operation.id}">Descargar cuenta PDF</button>
      ${canManage() ? `<button class="btn btn-secondary" data-action="correct-operation" data-id="${operation.id}">Corregir datos</button>` : ""}
      ${canManage() && operation.status === "reservada" ? `<button class="btn btn-danger" data-action="cancel-operation" data-id="${operation.id}">Cancelar con motivo</button>` : ""}
    </div>`, true);
}

async function openStartOperationForm(id) {
  const operation = await api(`/api/operations/${id}`);
  openModal("Registrar salida", `${operation.folio} · ${operation.plate}`, `
    <form data-form="operation-start" data-id="${operation.id}">
      <div class="flow-banner"><span>Salida</span><strong>Confirma el estado real antes de entregar la unidad.</strong></div>
      <div class="form-grid">
        <div class="form-group"><label>Fecha y hora *</label><input name="departureAt" type="datetime-local" value="${localDateTime()}" required /></div>
        <div class="form-group"><label>Kilometraje inicial *</label><input name="initialKm" type="number" min="${operation.initialKm || 0}" value="${operation.initialKm || 0}" required /></div>
        <div class="form-group"><label>Nivel de combustible *</label><select name="fuelLevelOut" required><option value="lleno">Lleno</option><option value="3/4">3/4</option><option value="1/2">1/2</option><option value="1/4">1/4</option><option value="reserva">Reserva</option></select></div>
        <div class="form-group"><label>Foto del odómetro</label><input name="departurePhoto" type="file" accept="image/*" capture="environment" /></div>
        <div class="form-group full"><label>Condición de salida *</label><textarea name="conditionOut" required placeholder="Llantas, carrocería, limpieza y observaciones"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Confirmar salida</button></div>
    </form>`);
}

async function openReturnOperationForm(id) {
  const operation = await api(`/api/operations/${id}`);
  openModal("Retorno y revisión", `${operation.folio} · ${operation.plate}`, `
    <form data-form="operation-return" data-id="${operation.id}">
      <div class="flow-banner success-flow"><span>Retorno</span><strong>Este formulario cierra bitácora y resguardo al mismo tiempo.</strong></div>
      <div class="form-grid">
        <div class="form-group"><label>Fecha y hora *</label><input name="returnedAt" type="datetime-local" value="${localDateTime()}" required /></div>
        <div class="form-group"><label>Kilometraje final *</label><input name="finalKm" type="number" min="${operation.initialKm || 0}" value="${operation.initialKm || 0}" required /></div>
        <div class="form-group"><label>Combustible al retornar *</label><select name="fuelLevelIn" required><option value="lleno">Lleno</option><option value="3/4">3/4</option><option value="1/2">1/2</option><option value="1/4">1/4</option><option value="reserva">Reserva</option></select></div>
        <div class="form-group"><label>Foto del odómetro</label><input name="returnPhoto" type="file" accept="image/*" capture="environment" /></div>
        <div class="form-group full"><label>Condición al retornar *</label><textarea name="conditionIn" required placeholder="Describe limpieza, carrocería, llantas y accesorios"></textarea></div>
        <label class="check-card full"><input name="hasDamage" type="checkbox" /><span><strong>Se encontró daño o incidente</strong><small>Activa los campos de detalle para conservar evidencia.</small></span></label>
        <div class="form-group"><label>Severidad del daño</label><select name="damageSeverity"><option value="media">Media</option><option value="baja">Baja</option><option value="alta">Alta</option></select></div>
        <label class="check-card"><input name="blocksVehicle" type="checkbox" /><span><strong>Bloquear unidad</strong><small>No podrá volver a asignarse.</small></span></label>
        <div class="form-group full"><label>Descripción del daño</label><textarea name="damageDescription"></textarea></div>
        <div class="form-group"><label>Costo estimado del daño</label><input name="damageCost" type="number" min="0" step="0.01" /></div>
        <div class="form-group"><label>Otro gasto del retorno</label><input name="extraExpense" type="number" min="0" step="0.01" /></div>
        <div class="form-group full"><label>Firma / evidencia</label><input name="signature" type="file" accept="image/*" capture="environment" /></div>
        <div class="form-group full"><label>Observaciones</label><textarea name="notes"></textarea></div>
        ${canManage() ? '<label class="check-card full approval-card"><input name="releaseNow" type="checkbox" /><span><strong>Aprobar revisión y liberar ahora</strong><small>Úsalo solo si la unidad quedó revisada y sin bloqueos.</small></span></label>' : ""}
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-success" type="submit">Cerrar retorno completo</button></div>
    </form>`, true);
}

async function openReviewOperationForm(id) {
  const operation = await api(`/api/operations/${id}`);
  openModal("Revisión final", `${operation.folio} · ${operation.plate}`, `
    <form data-form="operation-review" data-id="${operation.id}">
      <div class="form-grid">
        <div class="form-group full"><label>Resultado *</label><select name="result" required><option value="aprobada">Aprobada · liberar unidad</option><option value="mantenimiento">Enviar a mantenimiento</option></select></div>
        <div class="form-group full"><label>Observaciones</label><textarea name="notes">${escapeHtml(operation.reviewNotes || "")}</textarea></div>
        <div class="form-group full"><label>Trabajo requerido si va a mantenimiento</label><textarea name="maintenanceDescription"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar revisión</button></div>
    </form>`);
}

async function openCorrectionForm(id) {
  const operation = await api(`/api/operations/${id}`);
  await ensureCatalogs();
  openModal("Corregir operación", `${operation.folio} · el cambio quedará auditado`, `
    <form data-form="operation-correction" data-id="${operation.id}">
      <div class="form-grid">
        ${operation.status === "reservada" ? `<div class="form-group full"><label>Chofer</label><select name="driverId"><option value="">Sin chofer</option>${state.drivers.map((driver) => `<option value="${driver.id}" ${operation.driverId === driver.id ? "selected" : ""} ${driver.activeOperationFolio && driver.activeOperationFolio !== operation.folio ? "disabled" : ""}>${escapeHtml(driver.name)}${driver.activeOperationFolio && driver.activeOperationFolio !== operation.folio ? ` · ocupado en ${escapeHtml(driver.activeOperationFolio)}` : ""}</option>`).join("")}</select></div>` : ""}
        <div class="form-group"><label>Responsable</label><input name="responsibleName" value="${escapeHtml(operation.responsibleName || "")}" /></div>
        <div class="form-group"><label>Cliente</label><input name="clientName" value="${escapeHtml(operation.clientName || "")}" /></div>
        <div class="form-group"><label>Dependencia</label><input name="dependencyName" value="${escapeHtml(operation.dependencyName || "")}" /></div>
        <div class="form-group"><label>Destino</label><input name="destination" value="${escapeHtml(operation.destination || "")}" /></div>
        <div class="form-group full"><label>Motivo</label><input name="purpose" value="${escapeHtml(operation.purpose)}" /></div>
        <div class="form-group"><label>Ingreso</label><input name="income" type="number" step="0.01" value="${operation.income || 0}" /></div>
        <div class="form-group"><label>Costo cotizado</label><input name="quotedCost" type="number" step="0.01" value="${operation.quotedCost || 0}" /></div>
        <div class="form-group full correction-reason"><label>Motivo de la corrección *</label><textarea name="reason" required placeholder="Explica por qué se modifica el registro"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar corrección auditada</button></div>
    </form>`, true);
}

function openOperationExpenseForm(id) {
  openModal("Agregar gasto", "El costo se sumará automáticamente a la operación", `
    <form data-form="operation-expense" data-id="${id}">
      <div class="form-grid">
        <div class="form-group"><label>Fecha *</label><input name="expenseDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div>
        <div class="form-group"><label>Categoría *</label><select name="category" required><option value="casetas">Casetas</option><option value="estacionamiento">Estacionamiento</option><option value="viaticos">Viáticos</option><option value="reparacion">Reparación</option><option value="otros">Otros</option></select></div>
        <div class="form-group full"><label>Descripción *</label><input name="description" required /></div>
        <div class="form-group"><label>Importe *</label><input name="amount" type="number" min="0.01" step="0.01" required /></div>
        <div class="form-group"><label>Comprobante</label><input name="receipt" type="file" accept="image/*,application/pdf" /></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Agregar gasto</button></div>
    </form>`);
}

async function ensureCatalogs() {
  const promises = [];
  if (!state.vehicleTypes.length) promises.push(api("/api/vehicle-types").then((data) => { state.vehicleTypes = data; }));
  if (!state.drivers.length) promises.push(api("/api/drivers").then((data) => { state.drivers = data; }));
  if (!state.workshops.length) promises.push(api("/api/workshops").then((data) => { state.workshops = data; }));
  await Promise.all(promises);
}

async function renderVehicles(query = "", status = "") {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  const [vehicles] = await Promise.all([api(`/api/vehicles?${params}`), ensureCatalogs()]);
  state.vehicles = vehicles;
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Inventario operativo</span><h1>Vehículos</h1><p>Consulta disponibilidad, kilometraje, pólizas y el historial completo de cada unidad.</p></div>
      <div class="heading-actions">${canManage() ? '<button class="btn btn-primary" type="button" data-action="add-vehicle">+ Registrar vehículo</button>' : ""}</div>
    </div>
    <div class="toolbar">
      <div class="filters">
        <div class="search-wrap"><input id="vehicle-search" value="${escapeHtml(query)}" placeholder="Buscar por placa, marca, modelo o VIN…" aria-label="Buscar vehículos" /></div>
        <select id="vehicle-status" class="field" style="max-width:190px" aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          ${["disponible", "reservado", "en_uso", "pendiente_revision", "taller", "fuera_servicio", "inactivo"].map((value) => `<option value="${value}" ${status === value ? "selected" : ""}>${statusText(value)}</option>`).join("")}
        </select>
      </div>
      <span class="badge badge-activo">${vehicles.length} unidades</span>
    </div>
    ${vehicles.length ? `<section class="vehicle-grid">
      ${vehicles.map((vehicle) => `
        <article class="entity-card">
          <div class="card-top">
            <div class="vehicle-avatar">${escapeHtml(vehicle.typeName?.slice(0, 2).toUpperCase() || "VH")}</div>
            ${badge(vehicle.status)}
          </div>
          <h3>${escapeHtml(vehicle.plate)}</h3>
          <p class="subtitle">${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)} · ${escapeHtml(vehicle.year || "")}</p>
          <div class="data-pairs">
            <div class="data-pair"><span>Kilometraje</span><strong>${formatNumber(vehicle.currentMileage)} km</strong></div>
            <div class="data-pair"><span>Rendimiento</span><strong>${vehicle.averageConsumption || "—"} km/l</strong></div>
            <div class="data-pair"><span>Seguro</span><strong>${escapeHtml(vehicle.insurer || "Sin registro")}</strong></div>
            <div class="data-pair"><span>Vencimiento</span><strong>${formatDate(vehicle.insuranceExpiry)}</strong></div>
          </div>
          <div class="card-actions">
            <button class="btn btn-dark" type="button" data-action="vehicle-detail" data-id="${vehicle.id}">Ver ficha</button>
            ${canOperate() && vehicle.status === "disponible" ? `<button class="btn btn-ghost" type="button" data-action="add-operation" data-vehicle-id="${vehicle.id}">Crear operación</button>` : ""}
            ${canManage() ? `<button class="btn btn-ghost" type="button" data-action="edit-vehicle" data-id="${vehicle.id}">Editar</button>` : ""}
            ${state.user.role === "admin" && vehicle.status !== "inactivo" ? `<button class="btn btn-ghost" type="button" data-action="delete-vehicle" data-id="${vehicle.id}">Desactivar</button>` : ""}
          </div>
        </article>`).join("")}
    </section>` : emptyState("No encontramos vehículos", "Ajusta los filtros o registra una nueva unidad.", "VH")}`;
}

async function openVehicleForm(id = null) {
  await ensureCatalogs();
  const vehicle = id ? state.vehicles.find((item) => item.id === Number(id)) : null;
  openModal(
    vehicle ? "Editar vehículo" : "Registrar vehículo",
    "Datos administrativos, técnicos y de seguro",
    `<form data-form="vehicle" data-id="${vehicle?.id || ""}">
      <div class="form-grid">
        <div class="form-group"><label>Placa *</label><input name="plate" value="${escapeHtml(vehicle?.plate || "")}" required /></div>
        <div class="form-group"><label>Tipo de vehículo</label><select name="typeId"><option value="">Seleccionar</option>${state.vehicleTypes.map((type) => `<option value="${type.id}" ${vehicle?.typeId === type.id ? "selected" : ""}>${escapeHtml(type.name)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Marca *</label><input name="brand" value="${escapeHtml(vehicle?.brand || "")}" required /></div>
        <div class="form-group"><label>Modelo *</label><input name="model" value="${escapeHtml(vehicle?.model || "")}" required /></div>
        <div class="form-group"><label>Año</label><input name="year" type="number" min="1950" max="2100" value="${vehicle?.year || ""}" /></div>
        <div class="form-group"><label>Color</label><input name="color" value="${escapeHtml(vehicle?.color || "")}" /></div>
        <div class="form-group full"><label>VIN / Número de serie</label><input name="vin" value="${escapeHtml(vehicle?.vin || "")}" /></div>
        <div class="form-group"><label>Estado automático</label><input value="${escapeHtml(statusText(vehicle?.status || "disponible"))}" disabled /></div>
        ${vehicle ? `<div class="form-group"><label>Kilometraje protegido</label><input value="${formatNumber(vehicle.currentMileage)} km" disabled /><small>Solo cambia al cerrar operaciones o mediante ajuste administrativo.</small></div>` : '<div class="form-group"><label>Kilometraje inicial</label><input name="currentMileage" type="number" min="0" value="0" /></div>'}
        <div class="form-group"><label>Rendimiento km/l</label><input name="averageConsumption" type="number" min="0" step="0.1" value="${vehicle?.averageConsumption || ""}" /></div>
        <div class="form-group"><label>Aseguradora</label><input name="insurer" value="${escapeHtml(vehicle?.insurer || "")}" /></div>
        <div class="form-group"><label>Número de póliza</label><input name="policyNumber" value="${escapeHtml(vehicle?.policyNumber || "")}" /></div>
        <div class="form-group"><label>Vencimiento del seguro</label><input name="insuranceExpiry" type="date" value="${dateInputValue(vehicle?.insuranceExpiry)}" /></div>
        <div class="form-group full"><label>Modalidades habilitadas</label>
          <div class="checkbox-grid">
            <label class="check-card"><input type="checkbox" name="allowAdministrative" ${vehicle?.allowAdministrative !== 0 ? "checked" : ""} /><span><strong>Administrativo</strong><small>Comisiones y traslados.</small></span></label>
            <label class="check-card"><input type="checkbox" name="allowInternal" ${vehicle?.allowInternal !== 0 ? "checked" : ""} /><span><strong>Uso interno</strong><small>Resguardos y movimientos internos.</small></span></label>
            <label class="check-card"><input type="checkbox" name="allowTourism" ${vehicle?.allowTourism ? "checked" : ""} /><span><strong>Transporte turístico</strong><small>Requiere chofer vigente.</small></span></label>
            <label class="check-card"><input type="checkbox" name="allowRental" ${vehicle?.allowRental ? "checked" : ""} /><span><strong>Renta</strong><small>Puede entregarse a cliente.</small></span></label>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn btn-primary" type="submit">${vehicle ? "Guardar cambios" : "Registrar unidad"}</button>
      </div>
    </form>`
  );
}

async function openVehicleDetail(id, tab = "summary") {
  const [vehicle] = await Promise.all([api(`/api/vehicles/${id}`), ensureCatalogs()]);
  state.currentVehicle = vehicle;
  state.detailTab = tab;
  renderVehicleDetail();
}

function detailRows(items, columns) {
  if (!items.length) return emptyState("Sin registros", "Cuando captures información aparecerá en esta sección.", "—");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
        <tbody>${items.map((item) => `<tr>${columns.map((column) => `<td>${column.render ? column.render(item) : escapeHtml(item[column.key] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function renderVehicleDetail() {
  const vehicle = state.currentVehicle;
  const activeOperation = vehicle.operations.find((item) => ["reservada", "activa", "pendiente_revision"].includes(item.status));
  const tabs = [
    ["summary", "Resumen"],
    ["timeline", "Historial 360°"],
    ["operations", "Operaciones"],
    ["mileage", "Bitácora"],
    ["maintenance", "Mantenimientos"],
    ["documents", "Documentos"],
    ["fuel", "Combustible"],
    ["incidents", "Incidentes"],
    ["tires", "Llantas"],
    ["custody", "Resguardos"]
  ];
  let content = "";
  if (state.detailTab === "summary") {
    content = `
      ${activeOperation ? `<div class="active-operation-banner">
        <div><span>Operación actual</span><strong>${escapeHtml(activeOperation.folio)} · ${escapeHtml(operationTypeText(activeOperation.operationType))}</strong><small>${escapeHtml(activeOperation.driverName || "Responsable por confirmar")}</small></div>
        <button class="btn btn-primary" data-action="operation-detail" data-id="${activeOperation.id}">Abrir expediente</button>
      </div>` : ""}
      <div class="summary-grid">
        <div class="summary-box"><span>Tipo</span><strong>${escapeHtml(vehicle.typeName || "Sin tipo")}</strong></div>
        <div class="summary-box"><span>VIN</span><strong>${escapeHtml(vehicle.vin || "Sin registro")}</strong></div>
        <div class="summary-box"><span>Color</span><strong>${escapeHtml(vehicle.color || "Sin registro")}</strong></div>
        <div class="summary-box"><span>Kilometraje</span><strong>${formatNumber(vehicle.currentMileage)} km</strong></div>
        <div class="summary-box"><span>Aseguradora</span><strong>${escapeHtml(vehicle.insurer || "Sin registro")}</strong></div>
        <div class="summary-box"><span>Póliza</span><strong>${escapeHtml(vehicle.policyNumber || "Sin registro")}</strong></div>
        <div class="summary-box"><span>Vence seguro</span><strong>${formatDate(vehicle.insuranceExpiry)}</strong></div>
        <div class="summary-box"><span>Rendimiento</span><strong>${vehicle.averageConsumption || "—"} km/l</strong></div>
        <div class="summary-box"><span>Modalidades</span><strong>${[
          vehicle.allowAdministrative ? "Administrativo" : "",
          vehicle.allowInternal ? "Interno" : "",
          vehicle.allowTourism ? "Turismo" : "",
          vehicle.allowRental ? "Renta" : ""
        ].filter(Boolean).join(" · ") || "Sin modalidades"}</strong></div>
      </div>
      ${vehicle.alerts.length ? `<div class="alert-list" style="margin-top:18px">${vehicle.alerts.map((alert) => `<div class="alert-item severity-${alert.severity}"><div class="alert-icon">!</div><div><strong>${escapeHtml(alert.message)}</strong><span>${alert.dueDate ? formatDate(alert.dueDate) : `${formatNumber(alert.dueKm)} km`}</span></div>${badge(alert.severity)}</div>`).join("")}</div>` : ""}`;
  }
  if (state.detailTab === "timeline") {
    content = vehicle.timeline.length ? `<div class="vehicle-timeline">${vehicle.timeline.map((item) => `
      <div class="vehicle-timeline-item">
        <span class="timeline-type">${escapeHtml(item.type.slice(0, 2).toUpperCase())}</span>
        <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>
        <time>${formatDate(item.date, String(item.date || "").includes("T"))}</time>
      </div>`).join("")}</div>` : emptyState("Sin historial", "Los movimientos conectados aparecerán aquí.", "360");
  }
  if (state.detailTab === "operations") {
    content = detailRows(vehicle.operations, [
      { label: "Folio", render: (item) => `<button class="table-link" data-action="operation-detail" data-id="${item.id}">${escapeHtml(item.folio)}</button>` },
      { label: "Tipo", render: (item) => escapeHtml(operationTypeText(item.operationType)) },
      { label: "Responsable", key: "driverName" },
      { label: "Inicio", render: (item) => formatDate(item.departureAt || item.plannedStart, true) },
      { label: "Km", render: (item) => formatNumber(item.distanceKm) },
      { label: "Estado", render: (item) => badge(item.status) }
    ]);
  }
  if (state.detailTab === "mileage") {
    content = detailRows(vehicle.mileageLogs, [
      { label: "Salida", render: (item) => formatDate(item.departureAt, true) },
      { label: "Chofer", key: "driverName" },
      { label: "Km inicial", render: (item) => formatNumber(item.initialKm) },
      { label: "Km final", render: (item) => item.finalKm ? formatNumber(item.finalKm) : badge("en_uso") },
      { label: "Observaciones", key: "observations" }
    ]);
  }
  if (state.detailTab === "maintenance") {
    content = detailRows(vehicle.maintenance, [
      { label: "Fecha", render: (item) => formatDate(item.serviceDate) },
      { label: "Servicio", key: "serviceType" },
      { label: "Taller", key: "workshopName" },
      { label: "Costo", render: (item) => formatMoney(item.cost) },
      { label: "Estado", render: (item) => badge(item.status) },
      ...(canManage() ? [{ label: "Corrección", render: (item) => `<button class="btn btn-small btn-ghost" data-action="void-record" data-entity="maintenance" data-id="${item.id}">Anular</button>` }] : [])
    ]);
  }
  if (state.detailTab === "documents") {
    content = vehicle.documents.length ? `<div class="stack">${vehicle.documents.map((document) => `
      <div class="alert-item">
        <div class="alert-icon">PDF</div>
        <div><strong>${escapeHtml(document.originalName)}</strong><span>${escapeHtml(document.documentType)} · ${Math.ceil(document.sizeBytes / 1024)} KB · ${formatDate(document.uploadedAt)}</span></div>
        <button class="btn btn-ghost" type="button" data-action="download-document" data-id="${document.id}" data-name="${escapeHtml(document.originalName)}">Descargar</button>
      </div>`).join("")}</div>` : emptyState("Sin documentos", "Sube pólizas, facturas, inspecciones o archivos de placas.", "PDF");
  }
  if (state.detailTab === "fuel") {
    content = detailRows(vehicle.fuelVouchers, [
      { label: "Fecha", render: (item) => formatDate(item.voucherDate) },
      { label: "Chofer", key: "driverName" },
      { label: "Litros", render: (item) => `${item.liters} l` },
      { label: "Costo", render: (item) => formatMoney(item.totalCost) },
      { label: "Km", render: (item) => formatNumber(item.mileage) },
      { label: "Recibo", render: (item) => `<button class="btn btn-ghost" type="button" data-action="fuel-receipt" data-id="${item.id}">PDF</button>` },
      ...(canManage() ? [{ label: "Corrección", render: (item) => `<button class="btn btn-small btn-ghost" data-action="void-record" data-entity="fuel" data-id="${item.id}">Anular</button>` }] : [])
    ]);
  }
  if (state.detailTab === "incidents") {
    content = detailRows(vehicle.incidents, [
      { label: "Fecha", render: (item) => formatDate(item.incidentDate) },
      { label: "Chofer", key: "driverName" },
      { label: "Descripción", key: "description" },
      { label: "Costo", render: (item) => formatMoney(item.cost) },
      { label: "Estado", render: (item) => badge(item.status === "cerrado" ? "completada" : "abierta") },
      ...(canManage() ? [{ label: "Corrección", render: (item) => `<button class="btn btn-small btn-ghost" data-action="void-record" data-entity="incident" data-id="${item.id}">Anular</button>` }] : [])
    ]);
  }
  if (state.detailTab === "tires") {
    content = detailRows(vehicle.tireChanges, [
      { label: "Fecha", render: (item) => formatDate(item.changeDate) },
      { label: "Llanta", key: "tireType" },
      { label: "Posición", key: "position" },
      { label: "Proveedor", key: "supplier" },
      { label: "Costo", render: (item) => formatMoney(item.cost) },
      { label: "Km", render: (item) => formatNumber(item.mileage) },
      ...(canManage() ? [{ label: "Corrección", render: (item) => `<button class="btn btn-small btn-ghost" data-action="void-record" data-entity="tire" data-id="${item.id}">Anular</button>` }] : [])
    ]);
  }
  if (state.detailTab === "custody") {
    content = detailRows(vehicle.custodySheets, [
      { label: "Entrega", render: (item) => formatDate(item.deliveredAt, true) },
      { label: "Chofer", key: "driverName" },
      { label: "Km entrega", render: (item) => formatNumber(item.deliveryKm) },
      { label: "Retorno", render: (item) => item.returnedAt ? formatDate(item.returnedAt, true) : badge("en_uso") },
      { label: "Documento", render: (item) => `<button class="btn btn-ghost" type="button" data-action="custody-pdf" data-id="${item.id}">PDF</button>` },
      ...(canManage() ? [{ label: "Corrección", render: (item) => `<button class="btn btn-small btn-ghost" data-action="void-record" data-entity="custody" data-id="${item.id}">Anular</button>` }] : [])
    ]);
  }
  openModal(
    `Ficha · ${vehicle.plate}`,
    `${vehicle.brand} ${vehicle.model} · ${vehicle.year || "Año sin registrar"}`,
    `<div class="detail-banner">
      <div><span class="eyebrow">Unidad ${escapeHtml(vehicle.typeName || "")}</span><h3>${escapeHtml(vehicle.plate)}</h3><p>${formatNumber(vehicle.currentMileage)} km · ${escapeHtml(statusText(vehicle.status))}</p></div>
      <div class="quick-actions">
        ${activeOperation ? `<button class="btn btn-primary" type="button" data-action="operation-detail" data-id="${activeOperation.id}">Operación ${escapeHtml(activeOperation.folio)}</button>` : canOperate() && vehicle.status === "disponible" ? `<button class="btn btn-primary" type="button" data-action="add-operation" data-vehicle-id="${vehicle.id}">Crear operación</button>` : ""}
        ${canManage() ? `<button class="btn btn-secondary" type="button" data-action="document" data-id="${vehicle.id}">Documento</button>` : ""}
        ${activeOperation && canCapture() ? `<button class="btn btn-secondary" type="button" data-action="fuel" data-id="${vehicle.id}" data-operation-id="${activeOperation.id}">Combustible</button>` : ""}
        ${activeOperation && canCapture() ? `<button class="btn btn-secondary" type="button" data-action="incident" data-id="${vehicle.id}" data-operation-id="${activeOperation.id}">Incidente</button>` : ""}
        ${canManage() ? `<button class="btn btn-secondary" type="button" data-action="tire" data-id="${vehicle.id}">Llantas</button>` : ""}
      </div>
    </div>
    <div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.detailTab === id ? "active" : ""}" type="button" data-action="detail-tab" data-tab="${id}">${label}</button>`).join("")}</div>
    ${content}`,
    true
  );
}

function openMileageForm(vehicleId) {
  const vehicle = state.vehicles.find((item) => item.id === Number(vehicleId)) || state.currentVehicle;
  openModal("Registrar kilometraje", vehicle ? `${vehicle.plate} · ${formatNumber(vehicle.currentMileage)} km actuales` : "Bitácora de viaje", `
    <form data-form="mileage" data-id="${vehicleId}" enctype="multipart/form-data">
      <input type="hidden" name="vehicleId" value="${vehicleId}" />
      <div class="form-grid">
        <div class="form-group"><label>Chofer</label><select name="driverId"><option value="">Sin asignar</option>${state.drivers.filter((driver) => driver.active).map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Fecha y hora de salida *</label><input name="departureAt" type="datetime-local" value="${localDateTime()}" required /></div>
        <div class="form-group"><label>Kilometraje inicial *</label><input name="initialKm" type="number" min="0" value="${vehicle?.currentMileage || 0}" required /></div>
        <div class="form-group"><label>Kilometraje final</label><input name="finalKm" type="number" min="0" /><span class="form-note">Déjalo vacío si el viaje sigue activo.</span></div>
        <div class="form-group"><label>Fecha y hora de llegada</label><input name="arrivalAt" type="datetime-local" /></div>
        <div class="form-group"><label>Foto del odómetro</label><input name="photo" type="file" accept="image/*" capture="environment" /><span class="form-note">En móvil abre la cámara trasera.</span></div>
        <div class="form-group full"><label>Observaciones</label><textarea name="observations" placeholder="Ruta, comisión, novedades o condiciones de la unidad"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar registro</button></div>
    </form>`);
}

function openDocumentForm(vehicleId) {
  openModal("Subir documento", "PDF o imagen de hasta 8 MB", `
    <form data-form="document" data-id="${vehicleId}" enctype="multipart/form-data">
      <input type="hidden" name="vehicleId" value="${vehicleId}" />
      <input type="hidden" name="entityType" value="vehicle" />
      <input type="hidden" name="entityId" value="${vehicleId}" />
      <div class="form-grid">
        <div class="form-group"><label>Tipo de documento</label><select name="documentType"><option>Seguro</option><option>Placas</option><option>Factura</option><option>Inspección</option><option>Resguardo</option><option>Otro</option></select></div>
        <div class="form-group"><label>Archivo *</label><input name="document" type="file" accept="image/*,application/pdf" required /></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Subir documento</button></div>
    </form>`);
}

function openWhatsAppForm(vehicleId) {
  const vehicle = state.vehicles.find((item) => item.id === Number(vehicleId)) || state.currentVehicle;
  openModal("Avisar por WhatsApp", vehicle ? `Asignación de ${vehicle.plate}` : "Mensaje al chofer", `
    <form data-form="whatsapp" data-id="${vehicleId}">
      <div class="form-grid">
        <div class="form-group full"><label>Chofer *</label><select name="driverId" required><option value="">Seleccionar chofer</option>${state.drivers.filter((driver) => driver.active).map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)} · ${escapeHtml(driver.phone)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Fecha y hora</label><input name="dateTime" type="datetime-local" value="${localDateTime()}" /></div>
        <div class="form-group"><label>Kilometraje inicial</label><input name="km" type="number" value="${vehicle?.currentMileage || 0}" /></div>
      </div>
      <p class="form-note">Se abrirá WhatsApp con un mensaje prellenado y el intento quedará registrado en la auditoría.</p>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-success" type="submit">Abrir WhatsApp</button></div>
    </form>`);
}

function openFuelForm(vehicleId, operationId = "") {
  const vehicle = state.vehicles.find((item) => item.id === Number(vehicleId)) || state.currentVehicle;
  openModal("Vale de gasolina", vehicle ? `${vehicle.plate} · captura rápida` : "Captura rápida", `
    <form data-form="fuel" data-id="${vehicleId}" enctype="multipart/form-data">
      <input type="hidden" name="vehicleId" value="${vehicleId}" />
      <input type="hidden" name="operationId" value="${operationId}" />
      <div class="form-grid">
        <div class="form-group"><label>Chofer</label><select name="driverId"><option value="">Sin asignar</option>${state.drivers.filter((driver) => driver.active).map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Fecha *</label><input name="voucherDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div>
        <div class="form-group"><label>Litros *</label><input name="liters" type="number" min="0.01" step="0.01" required /></div>
        <div class="form-group"><label>Costo total *</label><input name="totalCost" type="number" min="0" step="0.01" required /></div>
        <div class="form-group"><label>Kilometraje *</label><input name="mileage" type="number" value="${vehicle?.currentMileage || 0}" required /></div>
        <div class="form-group"><label>Proveedor</label><input name="supplier" placeholder="Gasolinera o estación" /></div>
        <div class="form-group full"><label>Firma o comprobante</label><input name="signature" type="file" accept="image/*" capture="environment" /></div>
        <div class="form-group full"><label>Nota</label><textarea name="note"></textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Crear vale</button></div>
    </form>`);
}

function openIncidentForm(vehicleId, operationId = "") {
  openModal("Registrar incidente", "Conserva evidencia y costo estimado", `
    <form data-form="incident" data-id="${vehicleId}" enctype="multipart/form-data">
      <input type="hidden" name="vehicleId" value="${vehicleId}" />
      <input type="hidden" name="operationId" value="${operationId}" />
      <div class="form-grid">
        <div class="form-group"><label>Chofer</label><select name="driverId"><option value="">Sin asignar</option>${state.drivers.map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Fecha *</label><input name="incidentDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div>
        <div class="form-group"><label>Costo estimado</label><input name="cost" type="number" min="0" step="0.01" /></div>
        <div class="form-group"><label>Estado</label><select name="status"><option value="abierto">Abierto</option><option value="cerrado">Cerrado</option></select></div>
        <div class="form-group"><label>Severidad</label><select name="severity"><option value="media">Media</option><option value="baja">Baja</option><option value="alta">Alta</option></select></div>
        <label class="check-card"><input name="blocksVehicle" type="checkbox" /><span><strong>Bloquear unidad</strong><small>Evita nuevas asignaciones.</small></span></label>
        <div class="form-group full"><label>Descripción *</label><textarea name="description" required></textarea></div>
        <div class="form-group full"><label>Fotografía</label><input name="photo" type="file" accept="image/*" capture="environment" /></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar incidente</button></div>
    </form>`);
}

function openTireForm(vehicleId) {
  const vehicle = state.vehicles.find((item) => item.id === Number(vehicleId)) || state.currentVehicle;
  openModal("Cambio de llantas", vehicle ? `${vehicle.plate} · historial de componentes` : "Registro de llantas", `
    <form data-form="tire" data-id="${vehicleId}">
      <div class="form-grid">
        <div class="form-group"><label>Fecha *</label><input name="changeDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></div>
        <div class="form-group"><label>Tipo / medida *</label><input name="tireType" placeholder="Ej. 265/65 R17 AT" required /></div>
        <div class="form-group"><label>Posición *</label><select name="position"><option>Delantera izquierda</option><option>Delantera derecha</option><option>Trasera izquierda</option><option>Trasera derecha</option><option>Juego completo</option><option>Refacción</option></select></div>
        <div class="form-group"><label>Kilometraje</label><input name="mileage" type="number" min="0" value="${vehicle?.currentMileage || 0}" /></div>
        <div class="form-group"><label>Costo</label><input name="cost" type="number" min="0" step="0.01" /></div>
        <div class="form-group"><label>Proveedor</label><input name="supplier" /></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar cambio</button></div>
    </form>`);
}

function openCustodyForm(vehicleId) {
  const vehicle = state.vehicles.find((item) => item.id === Number(vehicleId)) || state.currentVehicle;
  openModal("Hoja de resguardo", vehicle ? `${vehicle.plate} · asignación de unidad` : "Asignación de unidad", `
    <form data-form="custody" data-id="${vehicleId}">
      <div class="form-grid">
        <div class="form-group full"><label>Chofer responsable *</label><select name="driverId" required><option value="">Seleccionar</option>${state.drivers.filter((driver) => driver.active).map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)} · ${escapeHtml(driver.licenseNumber)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Fecha y hora de entrega *</label><input name="deliveredAt" type="datetime-local" value="${localDateTime()}" required /></div>
        <div class="form-group"><label>Kilometraje de entrega *</label><input name="deliveryKm" type="number" min="0" value="${vehicle?.currentMileage || 0}" required /></div>
        <div class="form-group full"><label>Observaciones</label><textarea name="observations" placeholder="Estado físico, accesorios entregados, combustible y observaciones"></textarea></div>
      </div>
      <p class="form-note">Al guardar, la unidad cambiará a “En uso” y podrás descargar la hoja de resguardo desde su ficha.</p>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Generar resguardo</button></div>
    </form>`);
}

async function renderDrivers() {
  state.drivers = await api("/api/drivers");
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Personal autorizado</span><h1>Choferes</h1><p>Licencias, contacto, historial de viajes e incidentes por conductor.</p></div>
      <div class="heading-actions">${canManage() ? '<button class="btn btn-primary" type="button" data-action="add-driver">+ Nuevo chofer</button>' : ""}</div>
    </div>
    ${state.drivers.length ? `<section class="driver-grid">${state.drivers.map((driver) => `
      <article class="entity-card">
        <div class="card-top"><div class="driver-avatar">${escapeHtml(initials(driver.name))}</div>${badge(driver.active ? "activo" : "inactivo")}</div>
        <h3>${escapeHtml(driver.name)}</h3>
        <p class="subtitle">${escapeHtml(driver.phone)} · Lic. ${escapeHtml(driver.licenseNumber)}</p>
        <div class="data-pairs">
          <div class="data-pair"><span>Vence licencia</span><strong>${formatDate(driver.licenseExpiry)}</strong></div>
          <div class="data-pair"><span>Viajes</span><strong>${driver.tripCount}</strong></div>
          <div class="data-pair"><span>Incidentes</span><strong>${driver.incidentCount}</strong></div>
          <div class="data-pair"><span>Emergencia</span><strong>${escapeHtml(driver.emergencyPhone || "—")}</strong></div>
        </div>
        <div class="card-actions">
          <button class="btn btn-dark" type="button" data-action="driver-badge" data-id="${driver.id}">Gafete PDF</button>
          ${canManage() ? `<button class="btn btn-ghost" type="button" data-action="edit-driver" data-id="${driver.id}">Editar</button>` : ""}
          ${state.user.role === "admin" && driver.active ? `<button class="btn btn-ghost" type="button" data-action="delete-driver" data-id="${driver.id}">Desactivar</button>` : ""}
        </div>
      </article>`).join("")}</section>` : emptyState("Sin choferes", "Registra al primer conductor autorizado.", "CH")}`;
}

function openDriverForm(id = null) {
  const driver = id ? state.drivers.find((item) => item.id === Number(id)) : null;
  openModal(driver ? "Editar chofer" : "Registrar chofer", "Licencia, contacto y datos de emergencia", `
    <form data-form="driver" data-id="${driver?.id || ""}">
      <div class="form-grid">
        <div class="form-group full"><label>Nombre completo *</label><input name="name" value="${escapeHtml(driver?.name || "")}" required /></div>
        <div class="form-group"><label>Teléfono con lada *</label><input name="phone" value="${escapeHtml(driver?.phone || "52")}" required /></div>
        <div class="form-group"><label>Teléfono de emergencia</label><input name="emergencyPhone" value="${escapeHtml(driver?.emergencyPhone || "")}" /></div>
        <div class="form-group"><label>Número de licencia *</label><input name="licenseNumber" value="${escapeHtml(driver?.licenseNumber || "")}" required /></div>
        <div class="form-group"><label>Vencimiento</label><input name="licenseExpiry" type="date" value="${dateInputValue(driver?.licenseExpiry)}" /></div>
        <div class="form-group full"><label>Domicilio</label><input name="address" value="${escapeHtml(driver?.address || "")}" /></div>
        <div class="form-group full"><label>Notas</label><textarea name="notes">${escapeHtml(driver?.notes || "")}</textarea></div>
        ${driver ? `<div class="form-group full"><label><input name="active" type="checkbox" ${driver.active ? "checked" : ""} style="width:auto;min-height:auto" /> Chofer activo</label></div>` : ""}
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar chofer</button></div>
    </form>`);
}

async function renderWorkshops() {
  state.workshops = await api("/api/workshops");
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Red de servicio</span><h1>Talleres y concesionarias</h1><p>Directorio de contactos, especialidades, tarifas y servicios realizados.</p></div>
      <div class="heading-actions">${canManage() ? '<button class="btn btn-primary" type="button" data-action="add-workshop">+ Registrar taller</button>' : ""}</div>
    </div>
    ${state.workshops.length ? `<section class="workshop-grid">${state.workshops.map((workshop) => `
      <article class="entity-card">
        <div class="card-top"><div class="workshop-avatar">TL</div><span class="badge badge-activo">${workshop.serviceCount} servicios</span></div>
        <h3>${escapeHtml(workshop.name)}</h3>
        <p class="subtitle">${escapeHtml(workshop.contact || "Sin contacto")} · ${escapeHtml(workshop.phone || "Sin teléfono")}</p>
        <div class="data-pairs">
          <div class="data-pair" style="grid-column:1/-1"><span>Especialidades</span><strong>${escapeHtml(workshop.services || "Sin registro")}</strong></div>
          <div class="data-pair" style="grid-column:1/-1"><span>Tarifas</span><strong>${escapeHtml(workshop.standardRates || "Sin registro")}</strong></div>
        </div>
        <div class="card-actions">
          ${workshop.phone ? `<a class="btn btn-dark" href="tel:${escapeHtml(workshop.phone)}">Llamar</a>` : ""}
          ${canManage() ? `<button class="btn btn-ghost" type="button" data-action="edit-workshop" data-id="${workshop.id}">Editar</button>` : ""}
        </div>
      </article>`).join("")}</section>` : emptyState("Sin talleres", "Agrega proveedores para asignarlos a las órdenes.", "TL")}`;
}

function openWorkshopForm(id = null) {
  const workshop = id ? state.workshops.find((item) => item.id === Number(id)) : null;
  openModal(workshop ? "Editar taller" : "Registrar taller", "Contacto, servicios y tarifas de referencia", `
    <form data-form="workshop" data-id="${workshop?.id || ""}">
      <div class="form-grid">
        <div class="form-group full"><label>Nombre *</label><input name="name" value="${escapeHtml(workshop?.name || "")}" required /></div>
        <div class="form-group"><label>Contacto</label><input name="contact" value="${escapeHtml(workshop?.contact || "")}" /></div>
        <div class="form-group"><label>Teléfono</label><input name="phone" value="${escapeHtml(workshop?.phone || "")}" /></div>
        <div class="form-group full"><label>Correo</label><input name="email" type="email" value="${escapeHtml(workshop?.email || "")}" /></div>
        <div class="form-group full"><label>Domicilio</label><input name="address" value="${escapeHtml(workshop?.address || "")}" /></div>
        <div class="form-group full"><label>Servicios ofrecidos</label><textarea name="services">${escapeHtml(workshop?.services || "")}</textarea></div>
        <div class="form-group full"><label>Tarifas estándar</label><textarea name="standardRates">${escapeHtml(workshop?.standardRates || "")}</textarea></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar taller</button></div>
    </form>`);
}

async function renderMaintenance() {
  const [maintenance] = await Promise.all([api("/api/maintenance"), ensureCatalogs(), api("/api/vehicles").then((data) => { state.vehicles = data; })]);
  state.maintenance = maintenance;
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Salud de la flota</span><h1>Mantenimientos</h1><p>Crea órdenes, asigna talleres, registra costos y programa el siguiente servicio.</p></div>
      <div class="heading-actions">${["admin", "gestor", "taller"].includes(state.user.role) ? '<button class="btn btn-primary" type="button" data-action="add-maintenance">+ Nueva orden</button>' : ""}</div>
    </div>
    ${maintenance.length ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Unidad</th><th>Servicio</th><th>Taller</th><th>Fecha</th><th>Kilometraje</th><th>Costo</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${maintenance.map((item) => `<tr>
        <td><strong>${escapeHtml(item.plate)}</strong><br>${escapeHtml(item.brand)} ${escapeHtml(item.model)}</td>
        <td><strong>${escapeHtml(item.serviceType)}</strong><br>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.workshopName || "Sin asignar")}</td>
        <td>${formatDate(item.serviceDate)}</td>
        <td>${formatNumber(item.mileage)} km</td>
        <td>${formatMoney(item.cost)}</td>
        <td>${badge(item.status)}</td>
        <td><div class="card-actions">
          <button class="btn btn-ghost" type="button" data-action="edit-maintenance" data-id="${item.id}">Editar</button>
          ${item.status !== "completada" ? `<button class="btn btn-success" type="button" data-action="complete-maintenance" data-id="${item.id}">Completar</button>` : ""}
        </div></td>
      </tr>`).join("")}</tbody>
    </table></div>` : emptyState("Sin mantenimientos", "Crea la primera orden de servicio.", "MT")}`;
}

async function openMaintenanceForm(id = null) {
  await ensureCatalogs();
  const item = id ? state.maintenance.find((record) => record.id === Number(id)) : null;
  openModal(item ? "Editar orden" : "Nueva orden de mantenimiento", "Programa el servicio y su recurrencia", `
    <form data-form="maintenance" data-id="${item?.id || ""}" enctype="multipart/form-data">
      <div class="form-grid">
        <div class="form-group"><label>Vehículo *</label><select name="vehicleId" required ${item ? "disabled" : ""}><option value="">Seleccionar</option>${state.vehicles.map((vehicle) => `<option value="${vehicle.id}" ${item?.vehicleId === vehicle.id ? "selected" : ""}>${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.brand)} ${escapeHtml(vehicle.model)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Taller</label><select name="workshopId"><option value="">Sin asignar</option>${state.workshops.map((workshop) => `<option value="${workshop.id}" ${item?.workshopId === workshop.id ? "selected" : ""}>${escapeHtml(workshop.name)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Tipo de servicio *</label><input name="serviceType" value="${escapeHtml(item?.serviceType || "")}" placeholder="Preventivo, frenos, llantas…" required /></div>
        <div class="form-group"><label>Fecha *</label><input name="serviceDate" type="date" value="${dateInputValue(item?.serviceDate) || new Date().toISOString().slice(0, 10)}" required /></div>
        <div class="form-group full"><label>Descripción *</label><textarea name="description" required>${escapeHtml(item?.description || "")}</textarea></div>
        <div class="form-group"><label>Costo</label><input name="cost" type="number" min="0" step="0.01" value="${item?.cost || 0}" /></div>
        <div class="form-group"><label>Kilometraje del servicio</label><input name="mileage" type="number" min="0" value="${item?.mileage || ""}" /></div>
        <div class="form-group"><label>Próximo servicio en km</label><input name="nextServiceKm" type="number" min="0" value="${item?.nextServiceKm || ""}" /></div>
        <div class="form-group"><label>Próxima fecha</label><input name="nextServiceDate" type="date" value="${dateInputValue(item?.nextServiceDate)}" /></div>
        <div class="form-group"><label>Estado</label><select name="status">${["abierta", "en_proceso", "completada", "cancelada"].map((status) => `<option value="${status}" ${(item?.status || "abierta") === status ? "selected" : ""}>${statusText(status)}</option>`).join("")}</select></div>
        ${item ? "" : '<div class="form-group"><label>Factura / orden PDF</label><input name="invoice" type="file" accept="application/pdf,image/*" /></div>'}
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Guardar orden</button></div>
    </form>`, true);
}

function renderReports() {
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Análisis exportable</span><h1>Reportes personalizados</h1><p>Filtra por periodo y descarga información lista para compartir en CSV o PDF.</p></div>
    </div>
    <section class="report-builder">
      <article class="settings-section">
        <h3>Diseñador de reporte</h3>
        <p>Selecciona el origen de datos, periodo y formato de salida.</p>
        <form data-form="report">
          <div class="form-grid">
            <div class="form-group full"><label>Tipo de reporte</label><select name="type">
              <option value="operations">Expediente integral de operaciones</option>
              <option value="profitability">Rentabilidad y costo por vehículo</option>
              <option value="maintenance">Costos y mantenimientos</option>
              <option value="mileage">Kilometraje por chofer</option>
              <option value="fuel">Vales de combustible</option>
            </select></div>
            <div class="form-group"><label>Desde</label><input name="dateFrom" type="date" value="${new Date(new Date().setMonth(new Date().getMonth() - 6)).toISOString().slice(0, 10)}" /></div>
            <div class="form-group"><label>Hasta</label><input name="dateTo" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          </div>
          <div class="form-actions">
            <button class="btn btn-secondary" type="submit" name="format" value="csv">Descargar CSV</button>
            <button class="btn btn-primary" type="submit" name="format" value="pdf">Generar PDF</button>
          </div>
        </form>
      </article>
      <aside class="report-preview">
        <span class="eyebrow">Salida profesional</span>
        <h3>Información útil, sin ruido.</h3>
        <p>Cada reporte utiliza los registros vivos del sistema y conserva el periodo seleccionado para facilitar la auditoría.</p>
        <div class="report-features">
          <div class="report-feature"><span>✓</span> Ingreso, costo y utilidad por operación</div>
          <div class="report-feature"><span>✓</span> Costo por kilómetro y por vehículo</div>
          <div class="report-feature"><span>✓</span> Kilometraje por conductor</div>
          <div class="report-feature"><span>✓</span> Combustible por periodo</div>
          <div class="report-feature"><span>✓</span> PDF con identidad de la empresa</div>
        </div>
      </aside>
    </section>`;
}

async function renderAudit() {
  const logs = await api("/api/audit");
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Trazabilidad</span><h1>Bitácora de auditoría</h1><p>Consulta quién realizó cada alta, cambio, exportación o acceso al sistema.</p></div>
      <span class="badge badge-activo">${logs.length} eventos recientes</span>
    </div>
    <article class="panel">
      <header class="panel-header"><div><h2>Actividad del sistema</h2><p>Los registros se conservan con fecha, usuario y entidad</p></div></header>
      <div class="panel-body timeline">
        ${logs.length ? logs.map((log) => `
          <div class="timeline-item">
            <div class="timeline-marker">${escapeHtml(log.action.slice(0, 2).toUpperCase())}</div>
            <div><strong>${escapeHtml(log.userName || "Sistema")} · ${escapeHtml(log.action)}</strong><span>${escapeHtml(log.entityType)} ${log.entityId || ""} · ${escapeHtml(roleText(log.userRole || ""))}</span></div>
            <time>${formatDate(log.createdAt, true)}</time>
          </div>`).join("") : emptyState("Sin movimientos", "La actividad aparecerá aquí.", "AU")}
      </div>
    </article>`;
}

async function renderSettings() {
  const promises = [api("/api/settings")];
  if (state.user.role === "admin") promises.push(api("/api/users"));
  const [settings, users = []] = await Promise.all(promises);
  state.settings = settings;
  document.querySelector("#page-content").innerHTML = `
    <div class="page-heading">
      <div><span class="eyebrow">Administración</span><h1>Configuración</h1><p>Identidad de la empresa, alertas, usuarios, seguridad y respaldos.</p></div>
    </div>
    <section class="settings-grid">
      <div>
        ${state.user.role === "admin" ? `
          <article class="settings-section">
            <h3>Empresa y alertas</h3>
            <p>Esta información aparece en el sistema y en los PDF generados.</p>
            <form data-form="settings">
              <div class="form-grid">
                <div class="form-group full"><label>Nombre de la empresa</label><input name="companyName" value="${escapeHtml(settings.companyName)}" /></div>
                <div class="form-group"><label>Teléfono</label><input name="companyPhone" value="${escapeHtml(settings.companyPhone || "")}" /></div>
                <div class="form-group"><label>Días de anticipación</label><input name="alertDays" type="number" min="1" value="${settings.alertDays}" /></div>
                <div class="form-group full"><label>Domicilio</label><input name="companyAddress" value="${escapeHtml(settings.companyAddress || "")}" /></div>
                <div class="form-group"><label>Alerta de servicio en km</label><input name="alertKm" type="number" min="1" value="${settings.alertKm}" /></div>
                <div class="form-group"><label>Confirmar contraseña *</label><input name="confirmPassword" type="password" required /></div>
              </div>
              <div class="form-actions"><button class="btn btn-primary" type="submit">Guardar configuración</button></div>
            </form>
          </article>
          <article class="settings-section">
            <div class="panel-header" style="padding:0 0 16px;border:0"><div><h3>Usuarios y permisos</h3><p>${users.length} cuentas registradas</p></div><button class="btn btn-secondary" type="button" data-action="add-user">+ Usuario</button></div>
            <div class="stack">${users.map((user) => `
              <div class="alert-item">
                <div class="avatar">${escapeHtml(initials(user.name))}</div>
                <div><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.username)} · ${escapeHtml(user.email)}</span></div>
                <span class="badge badge-${user.active ? "activo" : "inactivo"}">${escapeHtml(roleText(user.role))}</span>
              </div>`).join("")}
            </div>
          </article>` : ""}
        <article class="settings-section">
          <h3>Cambiar mi contraseña</h3>
          <p>Usa una contraseña de al menos seis caracteres.</p>
          <form data-form="password">
            <div class="form-grid">
              <div class="form-group"><label>Contraseña actual</label><input name="currentPassword" type="password" required /></div>
              <div class="form-group"><label>Nueva contraseña</label><input name="newPassword" type="password" minlength="6" required /></div>
            </div>
            <div class="form-actions"><button class="btn btn-dark" type="submit">Actualizar contraseña</button></div>
          </form>
        </article>
      </div>
      <div>
        <article class="settings-section">
          <h3>Cuenta activa</h3>
          <p>Perfil con el que estás trabajando en este momento.</p>
          <div class="alert-item">
            <div class="avatar">${escapeHtml(initials(state.user.name))}</div>
            <div><strong>${escapeHtml(state.user.name)}</strong><span>${escapeHtml(state.user.email)}</span></div>
            <span class="badge badge-activo">${escapeHtml(roleText(state.user.role))}</span>
          </div>
        </article>
        ${state.user.role === "admin" ? `
          <article class="settings-section danger-zone">
            <h3>Respaldo y restauración</h3>
            <p>El ZIP completo incluye base de datos, fotografías, documentos, firmas y comprobantes. El respaldo JSON se conserva para restauración de datos.</p>
            <div class="stack">
              <button class="btn btn-secondary btn-block" type="button" data-action="backup">Descargar respaldo completo ZIP</button>
              <button class="btn btn-secondary btn-block" type="button" data-action="backup-json">Descargar datos JSON</button>
              <button class="btn btn-danger btn-block" type="button" data-action="restore">Restaurar archivo</button>
              <input id="restore-file" type="file" accept="application/json" hidden />
            </div>
          </article>` : ""}
        <article class="settings-section">
          <h3>Documentación técnica</h3>
          <p>La especificación OpenAPI permite revisar e integrar los endpoints del sistema.</p>
          <a class="btn btn-secondary btn-block" href="/api/docs" target="_blank" rel="noreferrer">Abrir documentación API</a>
        </article>
      </div>
    </section>`;
}

function openUserForm() {
  openModal("Crear usuario", "Asigna el nivel de acceso correcto", `
    <form data-form="user">
      <div class="form-grid">
        <div class="form-group full"><label>Nombre completo *</label><input name="name" required /></div>
        <div class="form-group"><label>Usuario *</label><input name="username" required /></div>
        <div class="form-group"><label>Correo *</label><input name="email" type="email" required /></div>
        <div class="form-group"><label>Teléfono</label><input name="phone" /></div>
        <div class="form-group"><label>Rol *</label><select name="role">
          <option value="gestor">Gestor de flota</option><option value="capturista">Capturista</option>
          <option value="chofer">Chofer</option><option value="taller">Taller</option>
          <option value="auditor">Consulta / auditoría</option><option value="admin">Administrador</option>
        </select></div>
        <div class="form-group full"><label>Contraseña temporal *</label><input name="password" type="password" minlength="6" required /></div>
      </div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancelar</button><button class="btn btn-primary" type="submit">Crear usuario</button></div>
    </form>`);
}

function openMandatoryPasswordForm() {
  openModal("Protege la cuenta inicial", "Antes del piloto cambia la contraseña admin", `
    <form data-form="mandatory-password">
      <div class="inline-warning">La contraseña <strong>admin</strong> es solo para el primer acceso y no debe conservarse en operación real.</div>
      <div class="form-grid">
        <div class="form-group full"><label>Contraseña actual</label><input name="currentPassword" type="password" value="admin" required /></div>
        <div class="form-group full"><label>Nueva contraseña segura</label><input name="newPassword" type="password" minlength="6" required /></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Guardar y continuar</button></div>
    </form>`);
  modalRoot.querySelector(".modal-close")?.remove();
  modalRoot.querySelector(".modal-overlay")?.removeAttribute("data-action");
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function handleForm(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const submitter = event.submitter;
  setButtonLoading(submitter, true);
  try {
    if (form.dataset.form === "login") {
      const data = formObject(form);
      const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
      state.token = result.token;
      state.user = result.user;
      localStorage.setItem("flotilla_token", state.token);
      state.settings = await api("/api/settings");
      renderShell();
      await navigate("dashboard");
      toast(`Bienvenido, ${state.user.name.split(" ")[0]}`);
      if (state.user.mustChangePassword) openMandatoryPasswordForm();
      return;
    }

    if (form.dataset.form === "vehicle") {
      const data = formObject(form);
      for (const field of ["allowAdministrative", "allowInternal", "allowTourism", "allowRental"]) {
        data[field] = form.elements[field]?.checked || false;
      }
      const id = form.dataset.id;
      await api(id ? `/api/vehicles/${id}` : "/api/vehicles", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
      closeModal();
      await renderVehicles();
      toast(id ? "Vehículo actualizado" : "Vehículo registrado");
    }

    if (form.dataset.form === "operation") {
      const result = await api("/api/operations", {
        method: "POST",
        body: JSON.stringify(formObject(form))
      });
      closeModal();
      state.vehicles = [];
      state.drivers = [];
      await navigate("operations");
      toast(`${result.folio} creada y unidad reservada`);
    }

    if (form.dataset.form === "operation-start") {
      const id = form.dataset.id;
      await api(`/api/operations/${id}/start`, { method: "POST", body: new FormData(form) });
      closeModal();
      state.vehicles = [];
      state.drivers = [];
      await renderOperations();
      toast("Salida confirmada; bitácora y resguardo quedaron abiertos");
    }

    if (form.dataset.form === "operation-return") {
      const id = form.dataset.id;
      await api(`/api/operations/${id}/return`, { method: "POST", body: new FormData(form) });
      closeModal();
      state.vehicles = [];
      state.drivers = [];
      await renderOperations();
      toast("Retorno guardado; kilometraje y resguardo quedaron actualizados");
    }

    if (form.dataset.form === "operation-review") {
      const id = form.dataset.id;
      await api(`/api/operations/${id}/review`, {
        method: "POST",
        body: JSON.stringify(formObject(form))
      });
      closeModal();
      state.vehicles = [];
      state.drivers = [];
      await renderOperations();
      toast("Revisión final guardada y estado de la unidad recalculado");
    }

    if (form.dataset.form === "operation-correction") {
      const id = form.dataset.id;
      await api(`/api/operations/${id}/correct`, {
        method: "PUT",
        body: JSON.stringify(formObject(form))
      });
      closeModal();
      await renderOperations();
      toast("Corrección guardada con motivo y auditoría");
    }

    if (form.dataset.form === "operation-expense") {
      const id = form.dataset.id;
      await api(`/api/operations/${id}/expenses`, { method: "POST", body: new FormData(form) });
      closeModal();
      await openOperationDetail(id);
      toast("Gasto agregado y costo total actualizado");
    }

    if (form.dataset.form === "mileage") {
      const vehicleId = form.dataset.id;
      await api(`/api/vehicles/${vehicleId}/mileage`, { method: "POST", body: new FormData(form) });
      closeModal();
      state.vehicles = [];
      await navigate(state.page === "dashboard" ? "dashboard" : "vehicles");
      toast("Kilometraje y bitácora guardados");
    }

    if (form.dataset.form === "document") {
      const vehicleId = form.dataset.id;
      await api("/api/documents/upload", { method: "POST", body: new FormData(form) });
      closeModal();
      toast("Documento guardado");
      await openVehicleDetail(vehicleId, "documents");
    }

    if (form.dataset.form === "whatsapp") {
      const data = formObject(form);
      data.vehicleId = Number(form.dataset.id);
      const result = await api("/api/notifications/whatsapp", { method: "POST", body: JSON.stringify(data) });
      closeModal();
      window.open(result.link, "_blank", "noopener,noreferrer");
      toast("Mensaje preparado y registrado");
    }

    if (form.dataset.form === "fuel") {
      const vehicleId = form.dataset.id;
      await api("/api/fuel-vouchers", { method: "POST", body: new FormData(form) });
      closeModal();
      toast("Vale de gasolina creado");
      await openVehicleDetail(vehicleId, "fuel");
    }

    if (form.dataset.form === "incident") {
      const vehicleId = form.dataset.id;
      await api("/api/incidents", { method: "POST", body: new FormData(form) });
      closeModal();
      toast("Incidente registrado");
      await openVehicleDetail(vehicleId, "incidents");
    }

    if (form.dataset.form === "tire") {
      const vehicleId = form.dataset.id;
      const data = formObject(form);
      data.vehicleId = Number(vehicleId);
      await api("/api/tire-changes", { method: "POST", body: JSON.stringify(data) });
      closeModal();
      toast("Cambio de llanta registrado");
      await openVehicleDetail(vehicleId, "tires");
    }

    if (form.dataset.form === "custody") {
      const vehicleId = form.dataset.id;
      const data = formObject(form);
      data.vehicleId = Number(vehicleId);
      await api("/api/custody-sheets", { method: "POST", body: JSON.stringify(data) });
      closeModal();
      toast("Hoja de resguardo generada");
      await openVehicleDetail(vehicleId, "custody");
    }

    if (form.dataset.form === "driver") {
      const data = formObject(form);
      if (form.dataset.id) data.active = form.elements.active.checked ? 1 : 0;
      await api(form.dataset.id ? `/api/drivers/${form.dataset.id}` : "/api/drivers", {
        method: form.dataset.id ? "PUT" : "POST",
        body: JSON.stringify(data)
      });
      closeModal();
      state.drivers = [];
      await renderDrivers();
      toast("Chofer guardado");
    }

    if (form.dataset.form === "workshop") {
      const data = formObject(form);
      await api(form.dataset.id ? `/api/workshops/${form.dataset.id}` : "/api/workshops", {
        method: form.dataset.id ? "PUT" : "POST",
        body: JSON.stringify(data)
      });
      closeModal();
      state.workshops = [];
      await renderWorkshops();
      toast("Taller guardado");
    }

    if (form.dataset.form === "maintenance") {
      const data = form.dataset.id ? formObject(form) : new FormData(form);
      await api(form.dataset.id ? `/api/maintenance/${form.dataset.id}` : "/api/maintenance", {
        method: form.dataset.id ? "PUT" : "POST",
        body: form.dataset.id ? JSON.stringify(data) : data
      });
      closeModal();
      await renderMaintenance();
      toast("Orden de mantenimiento guardada");
    }

    if (form.dataset.form === "report") {
      const data = formObject(form);
      const format = submitter?.value || "csv";
      const params = new URLSearchParams({ ...data, format });
      await apiDownload(`/api/reports?${params}`, `reporte-${data.type}.${format}`);
      toast("Reporte generado");
    }

    if (form.dataset.form === "settings") {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(formObject(form)) });
      state.settings = await api("/api/settings");
      renderShell();
      await navigate("settings");
      toast("Configuración actualizada");
    }

    if (form.dataset.form === "password") {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(formObject(form)) });
      form.reset();
      toast("Contraseña actualizada");
    }

    if (form.dataset.form === "mandatory-password") {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(formObject(form)) });
      state.user.mustChangePassword = false;
      closeModal();
      toast("Contraseña inicial reemplazada correctamente");
    }

    if (form.dataset.form === "user") {
      await api("/api/users", { method: "POST", body: JSON.stringify(formObject(form)) });
      closeModal();
      await renderSettings();
      toast("Usuario creado");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setButtonLoading(submitter, false);
  }
}

async function handleAction(event) {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    await navigate(pageButton.dataset.page);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    if (action === "open-menu") document.body.classList.add("menu-open");
    if (action === "close-menu") document.body.classList.remove("menu-open");
    if (action === "logout") logout();
    if (action === "close-modal") closeModal();
    if (action === "overlay-close" && event.target === button) closeModal();
    if (action === "add-vehicle") await openVehicleForm();
    if (action === "add-operation") await openOperationForm(button.dataset.vehicleId || null);
    if (action === "operation-detail") await openOperationDetail(id);
    if (action === "start-operation") await openStartOperationForm(id);
    if (action === "return-operation") await openReturnOperationForm(id);
    if (action === "review-operation") await openReviewOperationForm(id);
    if (action === "correct-operation") await openCorrectionForm(id);
    if (action === "add-operation-expense") openOperationExpenseForm(id);
    if (action === "operation-ticket") await apiDownload(`/api/operations/${id}/ticket.pdf`, `operacion-${id}.pdf`);
    if (action === "void-record") {
      const reason = prompt("Escribe el motivo de la anulación. El registro original se conservará en auditoría:");
      if (!reason?.trim()) return;
      const vehicleId = state.currentVehicle?.id;
      const tab = state.detailTab;
      await api(`/api/records/${button.dataset.entity}/${id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      if (vehicleId) await openVehicleDetail(vehicleId, tab);
      toast("Registro anulado sin eliminar su historial");
    }
    if (action === "cancel-operation") {
      const reason = prompt("Escribe el motivo de cancelación. La operación se conservará en el historial:");
      if (!reason?.trim()) return;
      await api(`/api/operations/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      closeModal();
      state.vehicles = [];
      state.drivers = [];
      await renderOperations();
      toast("Operación cancelada sin eliminar su historial");
    }
    if (action === "edit-vehicle") await openVehicleForm(id);
    if (action === "delete-vehicle") {
      const vehicle = state.vehicles.find((item) => item.id === Number(id));
      if (!confirm(`¿Desactivar ${vehicle?.plate || "este vehículo"}? Su historial se conservará.`)) return;
      await api(`/api/vehicles/${id}`, { method: "DELETE" });
      await renderVehicles();
      toast("Vehículo desactivado; el historial se conservó");
    }
    if (action === "vehicle-detail") await openVehicleDetail(id);
    if (action === "mileage") {
      await ensureCatalogs();
      openMileageForm(id);
    }
    if (action === "document") openDocumentForm(id);
    if (action === "whatsapp") {
      await ensureCatalogs();
      openWhatsAppForm(id);
    }
    if (action === "fuel") {
      await ensureCatalogs();
      openFuelForm(id, button.dataset.operationId || "");
    }
    if (action === "incident") {
      await ensureCatalogs();
      openIncidentForm(id, button.dataset.operationId || "");
    }
    if (action === "tire") openTireForm(id);
    if (action === "custody") {
      await ensureCatalogs();
      openCustodyForm(id);
    }
    if (action === "detail-tab") {
      state.detailTab = button.dataset.tab;
      renderVehicleDetail();
    }
    if (action === "download-document") await apiDownload(`/api/documents/${id}/download`, button.dataset.name || "documento");
    if (action === "fuel-receipt") await apiDownload(`/api/fuel-vouchers/${id}/receipt.pdf`, `vale-gasolina-${id}.pdf`);
    if (action === "custody-pdf") await apiDownload(`/api/custody-sheets/${id}/pdf`, `hoja-resguardo-${id}.pdf`);
    if (action === "add-driver") openDriverForm();
    if (action === "edit-driver") openDriverForm(id);
    if (action === "driver-badge") await apiDownload(`/api/drivers/${id}/badge.pdf`, `gafete-chofer-${id}.pdf`);
    if (action === "delete-driver") {
      if (!confirm("¿Desactivar este chofer? Ya no aparecerá como disponible para nuevas asignaciones.")) return;
      await api(`/api/drivers/${id}`, { method: "DELETE" });
      state.drivers = [];
      await renderDrivers();
      toast("Chofer desactivado");
    }
    if (action === "add-workshop") openWorkshopForm();
    if (action === "edit-workshop") openWorkshopForm(id);
    if (action === "add-maintenance") await openMaintenanceForm();
    if (action === "edit-maintenance") await openMaintenanceForm(id);
    if (action === "complete-maintenance") {
      await api(`/api/maintenance/${id}`, { method: "PUT", body: JSON.stringify({ status: "completada" }) });
      await renderMaintenance();
      toast("Orden completada y unidad liberada");
    }
    if (action === "quick-report") await navigate("reports");
    if (action === "add-user") openUserForm();
    if (action === "backup") {
      await apiDownload("/api/backup/full", `respaldo-completo-flotilla-${new Date().toISOString().slice(0, 10)}.zip`);
      toast("Respaldo completo descargado");
    }
    if (action === "backup-json") {
      await apiDownload("/api/backup", `respaldo-datos-flotilla-${new Date().toISOString().slice(0, 10)}.json`);
      toast("Respaldo de datos descargado");
    }
    if (action === "restore") document.querySelector("#restore-file")?.click();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function handleChange(event) {
  if (event.target.id === "vehicle-status") {
    await renderVehicles(document.querySelector("#vehicle-search")?.value || "", event.target.value);
  }
  if (event.target.id === "operation-status") {
    await renderOperations(event.target.value, document.querySelector("#operation-search")?.value || "");
  }
  if (event.target.id === "restore-file" && event.target.files?.[0]) {
    try {
      const password = prompt("Escribe tu contraseña de administrador para restaurar el respaldo:");
      if (!password) return;
      if (!confirm("La restauración reemplazará todos los datos actuales. ¿Deseas continuar?")) return;
      const backup = JSON.parse(await event.target.files[0].text());
      await api("/api/backup/restore", {
        method: "POST",
        body: JSON.stringify({ confirmPassword: password, backup })
      });
      state.vehicles = [];
      state.drivers = [];
      state.workshops = [];
      toast("Respaldo restaurado");
      await navigate("dashboard");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  }
}

function handleInput(event) {
  if (!["vehicle-search", "operation-search"].includes(event.target.id)) return;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    const task = event.target.id === "vehicle-search"
      ? renderVehicles(event.target.value, document.querySelector("#vehicle-status")?.value || "")
      : renderOperations(document.querySelector("#operation-status")?.value || "", event.target.value);
    task.catch((error) => toast(error.message, "error"));
  }, 320);
}

function logout(showMessage = true) {
  state.token = "";
  state.user = null;
  localStorage.removeItem("flotilla_token");
  closeModal();
  renderLogin();
  if (showMessage) toast("Sesión cerrada");
}

async function init() {
  document.addEventListener("submit", handleForm);
  document.addEventListener("click", handleAction);
  document.addEventListener("change", handleChange);
  document.addEventListener("input", handleInput);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!modalRoot.querySelector('[data-form="mandatory-password"]')) closeModal();
      document.body.classList.remove("menu-open");
    }
  });
  if (!state.token) {
    renderLogin();
    return;
  }
  try {
    [state.user, state.settings] = await Promise.all([api("/api/auth/me"), api("/api/settings")]);
    renderShell();
    await navigate(state.page);
    if (state.user.mustChangePassword) openMandatoryPasswordForm();
  } catch (error) {
    logout(false);
    toast(error.message, "error");
  }
}

init();
