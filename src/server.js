import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import PDFDocument from "pdfkit";
import { ZipArchive } from "archiver";
import swaggerUi from "swagger-ui-express";
import {
  audit,
  db,
  dbPath,
  nowIso,
  recomputeAllVehicleStatuses,
  recomputeVehicleStatus,
  refreshAlerts
} from "./database.js";
import { createToken, hashPassword, readToken, verifyPassword } from "./security.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, "..");
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(projectDir, "uploads"));
const secret = process.env.JWT_SECRET || "desarrollo-local-cambia-esta-clave";
fs.mkdirSync(uploadDir, { recursive: true });

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
]);

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const scope = req.body.vehicleId ? `vehicle-${Number(req.body.vehicleId)}` : "general";
    const destination = path.join(uploadDir, scope);
    fs.mkdirSync(destination, { recursive: true });
    callback(null, destination);
  },
  filename(req, file, callback) {
    const safe = file.originalname
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .toLowerCase();
    callback(null, `${Date.now()}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    callback(allowedMimeTypes.has(file.mimetype) ? null : new Error("Tipo de archivo no permitido"), allowedMimeTypes.has(file.mimetype));
  }
});

function camelize(row) {
  if (!row) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
      value
    ])
  );
}

function rows(statement, ...params) {
  return db.prepare(statement).all(...params).map(camelize);
}

function row(statement, ...params) {
  return camelize(db.prepare(statement).get(...params));
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || String(body[field]).trim() === "");
  if (missing.length) {
    const error = new Error(`Faltan campos obligatorios: ${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value) {
  if (value === "" || value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const payload = readToken(token, secret);
    const user = row(
      "SELECT id, name, username, email, role, phone, active, must_change_password FROM users WHERE id = ?",
      payload.sub
    );
    if (!user || !user.active) return res.status(401).json({ error: "Usuario inactivo o inexistente" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Sesión inválida o vencida" });
  }
}

function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "No tienes permiso para realizar esta acción" });
    next();
  };
}

function operationVisibility(req, alias = "o") {
  if (req.user.role === "chofer") {
    return {
      sql: ` AND EXISTS (
        SELECT 1 FROM drivers visible_driver
        WHERE visible_driver.id = ${alias}.driver_id AND visible_driver.user_id = ?
      )`,
      params: [req.user.id]
    };
  }
  if (req.user.role === "taller") {
    return {
      sql: ` AND (
        ${alias}.operation_type = 'traslado_taller'
        OR EXISTS (
          SELECT 1 FROM maintenance_records visible_maintenance
          WHERE visible_maintenance.operation_id = ${alias}.id
        )
      )`,
      params: []
    };
  }
  return { sql: "", params: [] };
}

function vehicleVisibility(req, alias = "v") {
  if (req.user.role !== "chofer") return { sql: "", params: [] };
  return {
    sql: ` AND EXISTS (
      SELECT 1 FROM operations visible_operation
      JOIN drivers visible_driver ON visible_driver.id = visible_operation.driver_id
      WHERE visible_operation.vehicle_id = ${alias}.id
        AND visible_driver.user_id = ?
        AND visible_operation.status NOT IN ('cancelada')
    )`,
    params: [req.user.id]
  };
}

function assertDriverCanOperate(driverId, operationId = null) {
  if (!driverId) return null;
  const driver = row("SELECT * FROM drivers WHERE id = ?", driverId);
  if (!driver || !driver.active) {
    const error = new Error("El chofer seleccionado no está activo");
    error.status = 400;
    throw error;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (driver.licenseExpiry && driver.licenseExpiry < today) {
    const error = new Error(`La licencia de ${driver.name} está vencida`);
    error.status = 409;
    throw error;
  }
  const busy = row(`
    SELECT id, folio FROM operations
    WHERE driver_id = ? AND status IN ('reservada','activa','pendiente_revision')
      AND (? IS NULL OR id != ?)
    LIMIT 1
  `, driverId, operationId, operationId);
  if (busy) {
    const error = new Error(`El chofer ya está asignado a ${busy.folio}`);
    error.status = 409;
    throw error;
  }
  return driver;
}

function assertVehicleModality(vehicle, operationType) {
  const field = {
    comision: "allowAdministrative",
    uso_interno: "allowInternal",
    transporte_turistico: "allowTourism",
    renta: "allowRental",
    resguardo: "allowInternal",
    traslado_taller: "allowAdministrative"
  }[operationType];
  if (field && !vehicle[field]) {
    const error = new Error("La unidad no tiene habilitada esta modalidad de operación");
    error.status = 409;
    throw error;
  }
}

function updateOperationCost(operationId) {
  const totals = row(`
    SELECT
      COALESCE((SELECT SUM(total_cost) FROM fuel_vouchers WHERE operation_id = ? AND is_void = 0), 0) +
      COALESCE((SELECT SUM(amount) FROM operation_expenses WHERE operation_id = ? AND is_void = 0), 0) +
      COALESCE((SELECT SUM(cost) FROM incidents WHERE operation_id = ? AND is_void = 0), 0) +
      COALESCE((SELECT SUM(cost) FROM maintenance_records WHERE operation_id = ? AND is_void = 0), 0)
      AS total
  `, operationId, operationId, operationId, operationId);
  db.prepare("UPDATE operations SET total_cost = ?, updated_at = ? WHERE id = ?")
    .run(asNumber(totals.total), nowIso(), operationId);
  return asNumber(totals.total);
}

function operationDetail(id, req = null) {
  let sql = `
    SELECT o.*, v.plate, v.brand, v.model, v.operational_status AS vehicle_status,
      d.name AS driver_name, d.phone AS driver_phone, d.license_number,
      u.name AS created_by_name, reviewer.name AS reviewed_by_name
    FROM operations o
    JOIN vehicles v ON v.id = o.vehicle_id
    LEFT JOIN drivers d ON d.id = o.driver_id
    LEFT JOIN users u ON u.id = o.created_by
    LEFT JOIN users reviewer ON reviewer.id = o.reviewed_by
    WHERE o.id = ?
  `;
  const params = [id];
  if (req) {
    const visibility = operationVisibility(req, "o");
    sql += visibility.sql;
    params.push(...visibility.params);
  }
  const operation = row(sql, ...params);
  if (!operation) return null;
  operation.fuelVouchers = rows(`
    SELECT * FROM fuel_vouchers WHERE operation_id = ? AND is_void = 0 ORDER BY voucher_date DESC
  `, id);
  operation.incidents = rows(`
    SELECT * FROM incidents WHERE operation_id = ? AND is_void = 0 ORDER BY incident_date DESC
  `, id);
  operation.expenses = rows(`
    SELECT * FROM operation_expenses WHERE operation_id = ? AND is_void = 0 ORDER BY expense_date DESC
  `, id);
  operation.documents = rows(`
    SELECT * FROM documents WHERE entity_type = 'operation' AND entity_id = ? ORDER BY uploaded_at DESC
  `, id);
  return operation;
}

function buildUpdate(table, allowedFields, id, body, fieldMap = {}) {
  const entries = allowedFields
    .filter((field) => body[field] !== undefined)
    .map((field) => [fieldMap[field] || field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), body[field]]);
  if (!entries.length) return false;
  const clauses = entries.map(([column]) => `${column} = ?`).join(", ");
  db.prepare(`UPDATE ${table} SET ${clauses} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  return true;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function sendCsv(res, filename, records) {
  if (!records.length) {
    res.type("text/csv").attachment(filename).send("Sin resultados\n");
    return;
  }
  const headers = Object.keys(records[0]);
  const csv = [
    headers.map(csvEscape).join(","),
    ...records.map((record) => headers.map((header) => csvEscape(record[header])).join(","))
  ].join("\n");
  res.type("text/csv; charset=utf-8").attachment(filename).send(`\uFEFF${csv}`);
}

function pdfHeader(doc, title) {
  const settings = row("SELECT * FROM settings WHERE id = 1");
  doc.fillColor("#0f172a").fontSize(20).font("Helvetica-Bold").text(settings.companyName || "Control de Flotilla");
  doc.moveDown(0.25).fillColor("#64748b").fontSize(9).font("Helvetica").text(settings.companyAddress || "");
  doc.moveDown(1).fillColor("#0f172a").fontSize(16).font("Helvetica-Bold").text(title);
  doc.moveDown(0.5).strokeColor("#14b8a6").lineWidth(2).moveTo(72, doc.y).lineTo(540, doc.y).stroke();
  doc.moveDown();
}

function formatPdfDate(value) {
  if (!value) return "Sin fecha";
  const date = new Date(String(value).includes("T") ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeStyle: String(value).includes("T") ? "short" : undefined }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-MX").format(Number(value || 0));
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2
  }).format(Number(value || 0));
}

const openApi = {
  openapi: "3.0.3",
  info: {
    title: "Control de Flotilla API",
    version: "1.1.0",
    description: "API REST del sistema integral de operaciones vehiculares."
  },
  servers: [{ url: "/api" }],
  paths: {
    "/auth/login": { post: { summary: "Iniciar sesión", responses: { 200: { description: "Sesión iniciada" } } } },
    "/dashboard": { get: { summary: "KPIs, alertas y actividad", responses: { 200: { description: "Dashboard" } } } },
    "/operations": {
      get: { summary: "Listar operaciones visibles para el perfil", responses: { 200: { description: "Operaciones" } } },
      post: { summary: "Crear folio y reservar unidad", responses: { 201: { description: "Operación creada" } } }
    },
    "/operations/{id}/start": {
      post: { summary: "Registrar salida, abrir bitácora y resguardo", responses: { 200: { description: "Operación iniciada" } } }
    },
    "/operations/{id}/return": {
      post: { summary: "Registrar retorno integral", responses: { 200: { description: "Retorno registrado" } } }
    },
    "/operations/{id}/review": {
      post: { summary: "Aprobar liberación o enviar a mantenimiento", responses: { 200: { description: "Revisión guardada" } } }
    },
    "/vehicles": {
      get: { summary: "Listar vehículos", responses: { 200: { description: "Vehículos" } } },
      post: { summary: "Crear vehículo", responses: { 201: { description: "Vehículo creado" } } }
    },
    "/vehicles/{id}": {
      get: { summary: "Ficha completa de vehículo", responses: { 200: { description: "Ficha" } } },
      put: { summary: "Editar vehículo", responses: { 200: { description: "Vehículo actualizado" } } },
      delete: { summary: "Eliminar vehículo", responses: { 204: { description: "Eliminado" } } }
    },
    "/vehicles/{id}/mileage": {
      post: { summary: "Registrar kilometraje y foto de odómetro", responses: { 201: { description: "Registro creado" } } }
    },
    "/maintenance": {
      get: { summary: "Listar mantenimientos", responses: { 200: { description: "Órdenes" } } },
      post: { summary: "Crear orden", responses: { 201: { description: "Orden creada" } } }
    },
    "/documents/upload": { post: { summary: "Subir documento", responses: { 201: { description: "Documento guardado" } } } },
    "/reports": { get: { summary: "Exportar CSV o PDF", responses: { 200: { description: "Archivo" } } } },
    "/notifications/whatsapp": { post: { summary: "Generar enlace de WhatsApp", responses: { 200: { description: "Enlace generado" } } } }
  }
};

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"]
      }
    }
  }));
  app.use(express.json({ limit: "12mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(projectDir, "public"), { extensions: ["html"] }));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: "Control de Flotilla API" }));
  app.get("/api/openapi.json", (req, res) => res.json(openApi));

  app.get("/api/health", (req, res) => res.json({ status: "ok", time: nowIso() }));

  app.post("/api/auth/login", (req, res) => {
    const identifier = String(req.body.identifier || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const userRaw = db.prepare(`
      SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?
    `).get(identifier, identifier);
    if (!userRaw || !userRaw.active || !verifyPassword(password, userRaw.password_salt, userRaw.password_hash)) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }
    const user = camelize(userRaw);
    audit(user.id, "login", "session", user.id, null, { username: user.username });
    res.json({
      token: createToken(user, secret),
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        phone: user.phone,
        mustChangePassword: Boolean(user.mustChangePassword)
      }
    });
  });

  app.use("/api", auth);

  app.get("/api/auth/me", (req, res) => res.json(req.user));

  app.post("/api/auth/change-password", (req, res) => {
    required(req.body, ["currentPassword", "newPassword"]);
    if (String(req.body.newPassword).length < 6) return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!verifyPassword(req.body.currentPassword, user.password_salt, user.password_hash)) {
      return res.status(400).json({ error: "La contraseña actual no es correcta" });
    }
    const { salt, hash } = hashPassword(req.body.newPassword);
    db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?
    `).run(hash, salt, nowIso(), req.user.id);
    audit(req.user.id, "change_password", "user", req.user.id);
    res.json({ message: "Contraseña actualizada" });
  });

  app.get("/api/dashboard", (req, res) => {
    recomputeAllVehicleStatuses();
    refreshAlerts();
    const assignedDriver = req.user.role === "chofer"
      ? row("SELECT id FROM drivers WHERE user_id = ?", req.user.id)
      : null;
    const driverFilter = assignedDriver ? " AND o.driver_id = ?" : "";
    const driverParams = assignedDriver ? [assignedDriver.id] : [];
    const metrics = row(`
      SELECT
        (SELECT COUNT(*) FROM vehicles WHERE operational_status != 'inactivo') AS total_vehicles,
        (SELECT COUNT(*) FROM vehicles WHERE operational_status = 'disponible') AS available_vehicles,
        (SELECT COUNT(*) FROM vehicles WHERE operational_status = 'reservado') AS reserved_vehicles,
        (SELECT COUNT(*) FROM vehicles WHERE operational_status = 'en_uso') AS occupied_vehicles,
        (SELECT COUNT(*) FROM vehicles WHERE operational_status = 'pendiente_revision') AS pending_returns,
        (SELECT COUNT(*) FROM vehicles WHERE operational_status = 'taller') AS workshop_vehicles,
        (SELECT COALESCE(SUM(current_mileage), 0) FROM vehicles WHERE operational_status != 'inactivo') AS total_km,
        (SELECT COALESCE(SUM(total_cost), 0) FROM operations o
          WHERE date(o.created_at) >= date('now','start of month') ${driverFilter}) AS monthly_operation_cost,
        (SELECT COALESCE(SUM(income), 0) FROM operations o
          WHERE date(o.created_at) >= date('now','start of month') ${driverFilter}) AS monthly_income,
        (SELECT COUNT(*) FROM operations o
          WHERE o.status IN ('reservada','activa','pendiente_revision') ${driverFilter}) AS open_operations,
        (SELECT COUNT(*) FROM custody_sheets c
          JOIN operations o ON o.id = c.operation_id
          WHERE c.returned_at IS NULL ${driverFilter}) AS open_custodies,
        (SELECT COUNT(*) FROM alerts WHERE resolved = 0) AS active_alerts
    `, ...driverParams, ...driverParams, ...driverParams, ...driverParams);
    const alerts = rows(`
      SELECT * FROM alerts WHERE resolved = 0
      ORDER BY CASE severity WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, due_date ASC
      LIMIT 10
    `);
    const activity = rows(`
      SELECT a.*, u.name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 8
    `);
    const availability = rows(`
      SELECT operational_status AS status, COUNT(*) AS total
      FROM vehicles GROUP BY operational_status ORDER BY total DESC
    `);
    const upcoming = rows(`
      SELECT m.id, m.service_type, m.service_date, m.status, v.plate, v.brand, v.model, w.name AS workshop_name
      FROM maintenance_records m
      JOIN vehicles v ON v.id = m.vehicle_id
      LEFT JOIN workshops w ON w.id = m.workshop_id
      WHERE m.status IN ('abierta','en_proceso')
      ORDER BY m.service_date ASC LIMIT 6
    `);
    const tasks = rows(`
      SELECT o.id, o.folio, o.status, o.planned_start, o.planned_end, v.plate,
        d.name AS driver_name, o.destination
      FROM operations o
      JOIN vehicles v ON v.id = o.vehicle_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.status IN ('reservada','activa','pendiente_revision') ${driverFilter}
      ORDER BY CASE o.status WHEN 'pendiente_revision' THEN 1 WHEN 'activa' THEN 2 ELSE 3 END,
        o.planned_start
      LIMIT 10
    `, ...driverParams);
    res.json({ metrics, alerts, activity, availability, upcoming, tasks });
  });

  app.get("/api/operations", (req, res) => {
    const status = String(req.query.status || "").trim();
    const type = String(req.query.type || "").trim();
    const query = String(req.query.q || "").trim();
    let sql = `
      SELECT o.*, v.plate, v.brand, v.model, v.operational_status AS vehicle_status,
        d.name AS driver_name,
        COALESCE(o.final_km - o.initial_km, 0) AS distance_km,
        o.income - o.total_cost AS profit
      FROM operations o
      JOIN vehicles v ON v.id = o.vehicle_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE 1 = 1
    `;
    const params = [];
    if (status) {
      sql += " AND o.status = ?";
      params.push(status);
    }
    if (type) {
      sql += " AND o.operation_type = ?";
      params.push(type);
    }
    if (query) {
      const like = `%${query}%`;
      sql += " AND (o.folio LIKE ? OR v.plate LIKE ? OR o.client_name LIKE ? OR o.destination LIKE ?)";
      params.push(like, like, like, like);
    }
    const visibility = operationVisibility(req, "o");
    sql += visibility.sql;
    params.push(...visibility.params);
    sql += `
      ORDER BY CASE o.status
        WHEN 'pendiente_revision' THEN 1 WHEN 'activa' THEN 2 WHEN 'reservada' THEN 3
        WHEN 'borrador' THEN 4 ELSE 5 END, o.planned_start DESC
    `;
    res.json(rows(sql, ...params));
  });

  app.post("/api/operations", allow("admin", "gestor", "capturista"), (req, res) => {
    required(req.body, ["operationType", "vehicleId", "purpose", "plannedStart"]);
    const allowedTypes = ["comision", "uso_interno", "transporte_turistico", "renta", "resguardo", "traslado_taller"];
    if (!allowedTypes.includes(req.body.operationType)) return res.status(400).json({ error: "Tipo de operación inválido" });
    recomputeVehicleStatus(req.body.vehicleId);
    const vehicle = row("SELECT * FROM vehicles WHERE id = ?", req.body.vehicleId);
    if (!vehicle) return res.status(404).json({ error: "Vehículo no encontrado" });
    if (vehicle.operationalStatus !== "disponible") {
      return res.status(409).json({ error: `La unidad no está disponible; su estado actual es ${vehicle.operationalStatus}` });
    }
    assertVehicleModality(vehicle, req.body.operationType);
    const driverId = asNullableNumber(req.body.driverId);
    if (req.body.operationType === "transporte_turistico" && !driverId) {
      return res.status(400).json({ error: "El chofer es obligatorio para transporte turístico" });
    }
    if (!driverId && !String(req.body.responsibleName || req.body.clientName || "").trim()) {
      return res.status(400).json({ error: "Asigna un chofer, responsable o cliente" });
    }
    assertDriverCanOperate(driverId);
    if (req.body.plannedEnd && new Date(req.body.plannedEnd) < new Date(req.body.plannedStart)) {
      return res.status(400).json({ error: "La fecha programada de retorno no puede ser anterior a la salida" });
    }
    const stamp = nowIso();
    const result = db.prepare(`
      INSERT INTO operations
      (folio, operation_type, status, vehicle_id, driver_id, responsible_name, client_name,
       dependency_name, destination, purpose, planned_start, planned_end, initial_km,
       fuel_level_out, condition_out, income, quoted_cost, notes, created_by, created_at, updated_at)
      VALUES (NULL, ?, 'reservada', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.operationType,
      req.body.vehicleId,
      driverId,
      req.body.responsibleName || "",
      req.body.clientName || "",
      req.body.dependencyName || "",
      req.body.destination || "",
      req.body.purpose,
      req.body.plannedStart,
      req.body.plannedEnd || null,
      vehicle.currentMileage,
      req.body.fuelLevelOut || "",
      req.body.conditionOut || "",
      asNumber(req.body.income),
      asNumber(req.body.quotedCost),
      req.body.notes || "",
      req.user.id,
      stamp,
      stamp
    );
    const id = Number(result.lastInsertRowid);
    const folio = `OP-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
    db.prepare("UPDATE operations SET folio = ? WHERE id = ?").run(folio, id);
    recomputeVehicleStatus(vehicle.id);
    const created = operationDetail(id);
    audit(req.user.id, "create", "operation", id, null, created);
    res.status(201).json(created);
  });

  app.get("/api/operations/:id", (req, res) => {
    const operation = operationDetail(req.params.id, req);
    if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
    res.json(operation);
  });

  app.put("/api/operations/:id/correct", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["reason"]);
    const before = operationDetail(req.params.id);
    if (!before) return res.status(404).json({ error: "Operación no encontrada" });
    if (req.body.driverId !== undefined && before.status !== "reservada") {
      return res.status(409).json({ error: "El chofer solo puede cambiarse antes de iniciar la operación" });
    }
    const driverId = req.body.driverId === undefined ? before.driverId : asNullableNumber(req.body.driverId);
    if (driverId !== before.driverId) assertDriverCanOperate(driverId, before.id);
    buildUpdate(
      "operations",
      ["driverId", "responsibleName", "clientName", "dependencyName", "destination", "purpose",
        "plannedStart", "plannedEnd", "income", "quotedCost", "notes", "updatedAt"],
      req.params.id,
      { ...req.body, driverId, updatedAt: nowIso() }
    );
    updateOperationCost(before.id);
    const after = operationDetail(req.params.id);
    db.prepare(`
      INSERT INTO record_corrections
      (entity_type, entity_id, reason, previous_data, corrected_data, corrected_by, corrected_at)
      VALUES ('operation', ?, ?, ?, ?, ?, ?)
    `).run(after.id, req.body.reason, JSON.stringify(before), JSON.stringify(after), req.user.id, nowIso());
    audit(req.user.id, "correct", "operation", after.id, { ...before, reason: req.body.reason }, after);
    res.json(after);
  });

  app.post(
    "/api/operations/:id/start",
    allow("admin", "gestor", "capturista", "chofer"),
    upload.single("departurePhoto"),
    (req, res) => {
      required(req.body, ["departureAt", "initialKm", "fuelLevelOut", "conditionOut"]);
      const operation = operationDetail(req.params.id, req);
      if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
      if (operation.status !== "reservada") return res.status(409).json({ error: "Solo una operación reservada puede iniciar" });
      if (req.user.role === "chofer") {
        const driver = row("SELECT user_id FROM drivers WHERE id = ?", operation.driverId);
        if (!driver || driver.userId !== req.user.id) return res.status(403).json({ error: "Esta operación no está asignada a tu perfil" });
      }
      const vehicle = row("SELECT * FROM vehicles WHERE id = ?", operation.vehicleId);
      const initialKm = asNumber(req.body.initialKm);
      if (initialKm < vehicle.currentMileage) {
        return res.status(409).json({ error: `El kilometraje no puede ser menor al último registrado (${vehicle.currentMileage} km)` });
      }
      assertDriverCanOperate(operation.driverId, operation.id);
      const activeForVehicle = row(`
        SELECT id, folio FROM operations
        WHERE vehicle_id = ? AND status = 'activa' AND id != ? LIMIT 1
      `, operation.vehicleId, operation.id);
      if (activeForVehicle) return res.status(409).json({ error: `La unidad ya está en uso en ${activeForVehicle.folio}` });
      const stamp = nowIso();
      db.exec("BEGIN");
      try {
        db.prepare(`
          UPDATE operations SET status = 'activa', departure_at = ?, initial_km = ?,
            fuel_level_out = ?, condition_out = ?, departure_photo = ?, updated_at = ?
          WHERE id = ?
        `).run(
          req.body.departureAt,
          initialKm,
          req.body.fuelLevelOut,
          req.body.conditionOut,
          req.file?.path || "",
          stamp,
          operation.id
        );
        db.prepare(`
          INSERT INTO mileage_logs
          (vehicle_id, driver_id, departure_at, initial_km, odometer_photo, observations,
           created_by, created_at, operation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          operation.vehicleId,
          operation.driverId,
          req.body.departureAt,
          initialKm,
          req.file?.path || "",
          `Salida de ${operation.folio}`,
          req.user.id,
          stamp,
          operation.id
        );
        if (operation.driverId) {
          db.prepare(`
            INSERT INTO custody_sheets
            (vehicle_id, driver_id, delivered_at, delivery_km, observations, created_by, created_at, operation_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            operation.vehicleId,
            operation.driverId,
            req.body.departureAt,
            initialKm,
            `Resguardo automático de ${operation.folio}`,
            req.user.id,
            stamp,
            operation.id
          );
        }
        db.prepare("UPDATE vehicles SET current_mileage = ?, updated_at = ? WHERE id = ?")
          .run(initialKm, stamp, operation.vehicleId);
        audit(req.user.id, "start", "operation", operation.id, operation, { initialKm, departureAt: req.body.departureAt });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      recomputeVehicleStatus(operation.vehicleId);
      res.json(operationDetail(operation.id));
    }
  );

  app.post(
    "/api/operations/:id/return",
    allow("admin", "gestor", "capturista", "chofer"),
    upload.fields([
      { name: "returnPhoto", maxCount: 1 },
      { name: "signature", maxCount: 1 }
    ]),
    (req, res) => {
      required(req.body, ["returnedAt", "finalKm", "fuelLevelIn", "conditionIn"]);
      const operation = operationDetail(req.params.id, req);
      if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
      if (operation.status !== "activa") return res.status(409).json({ error: "La operación no está activa" });
      const finalKm = asNumber(req.body.finalKm);
      if (finalKm < asNumber(operation.initialKm)) {
        return res.status(409).json({ error: "El kilometraje final no puede ser menor al inicial" });
      }
      if (new Date(req.body.returnedAt) < new Date(operation.departureAt)) {
        return res.status(409).json({ error: "El retorno no puede ser anterior a la salida" });
      }
      const returnPhoto = req.files?.returnPhoto?.[0]?.path || "";
      const signaturePath = req.files?.signature?.[0]?.path || "";
      const hasDamage = String(req.body.hasDamage || "") === "true" || String(req.body.hasDamage || "") === "on";
      const severity = ["baja", "media", "alta"].includes(req.body.damageSeverity) ? req.body.damageSeverity : "media";
      const blocksVehicle = hasDamage && (severity === "alta" || String(req.body.blocksVehicle) === "true" || String(req.body.blocksVehicle) === "on");
      const stamp = nowIso();
      db.exec("BEGIN");
      try {
        db.prepare(`
          UPDATE operations SET status = 'pendiente_revision', returned_at = ?, final_km = ?,
            fuel_level_in = ?, condition_in = ?, return_photo = ?, signature_path = ?,
            review_notes = ?, updated_at = ?
          WHERE id = ?
        `).run(
          req.body.returnedAt,
          finalKm,
          req.body.fuelLevelIn,
          req.body.conditionIn,
          returnPhoto,
          signaturePath,
          req.body.notes || "",
          stamp,
          operation.id
        );
        db.prepare(`
          UPDATE mileage_logs SET arrival_at = ?, final_km = ?,
            observations = COALESCE(observations, '') || ? WHERE operation_id = ? AND is_void = 0
        `).run(req.body.returnedAt, finalKm, req.body.notes ? ` · ${req.body.notes}` : "", operation.id);
        db.prepare(`
          UPDATE custody_sheets SET returned_at = ?, return_km = ?,
            observations = COALESCE(observations, '') || ? WHERE operation_id = ? AND returned_at IS NULL
        `).run(req.body.returnedAt, finalKm, req.body.notes ? ` · ${req.body.notes}` : "", operation.id);
        db.prepare("UPDATE vehicles SET current_mileage = ?, updated_at = ? WHERE id = ?")
          .run(finalKm, stamp, operation.vehicleId);
        if (hasDamage) {
          const description = String(req.body.damageDescription || "").trim();
          if (!description) throw Object.assign(new Error("Describe el daño encontrado"), { status: 400 });
          db.prepare(`
            INSERT INTO incidents
            (vehicle_id, driver_id, incident_date, description, cost, status, created_by, created_at,
             operation_id, severity, blocks_vehicle)
            VALUES (?, ?, ?, ?, ?, 'abierto', ?, ?, ?, ?, ?)
          `).run(
            operation.vehicleId,
            operation.driverId,
            String(req.body.returnedAt).slice(0, 10),
            description,
            asNumber(req.body.damageCost),
            req.user.id,
            stamp,
            operation.id,
            severity,
            blocksVehicle ? 1 : 0
          );
        }
        if (asNumber(req.body.extraExpense) > 0) {
          db.prepare(`
            INSERT INTO operation_expenses
            (operation_id, expense_date, category, description, amount, created_by, created_at, updated_at)
            VALUES (?, ?, 'otros', ?, ?, ?, ?, ?)
          `).run(
            operation.id,
            String(req.body.returnedAt).slice(0, 10),
            req.body.expenseDescription || "Gasto registrado al retorno",
            asNumber(req.body.extraExpense),
            req.user.id,
            stamp,
            stamp
          );
        }
        audit(req.user.id, "return", "operation", operation.id, operation, {
          finalKm,
          returnedAt: req.body.returnedAt,
          hasDamage,
          blocksVehicle
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      updateOperationCost(operation.id);
      recomputeVehicleStatus(operation.vehicleId);
      if (
        ["admin", "gestor"].includes(req.user.role) &&
        (String(req.body.releaseNow) === "true" || String(req.body.releaseNow) === "on") &&
        !blocksVehicle
      ) {
        db.prepare(`
          UPDATE operations SET status = 'cerrada', review_result = 'aprobada',
            reviewed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?
        `).run(req.user.id, stamp, stamp, operation.id);
        audit(req.user.id, "review_approve", "operation", operation.id, null, { releaseNow: true });
        recomputeVehicleStatus(operation.vehicleId);
      }
      res.json(operationDetail(operation.id));
    }
  );

  app.post("/api/operations/:id/review", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["result"]);
    const operation = operationDetail(req.params.id);
    if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
    if (operation.status !== "pendiente_revision") {
      return res.status(409).json({ error: "La operación no está pendiente de revisión" });
    }
    const stamp = nowIso();
    if (req.body.result === "mantenimiento") {
      required(req.body, ["maintenanceDescription"]);
      db.prepare(`
        INSERT INTO maintenance_records
        (vehicle_id, service_type, description, service_date, cost, mileage, status, created_by,
         created_at, updated_at, operation_id)
        VALUES (?, 'Revisión posterior a operación', ?, ?, 0, ?, 'abierta', ?, ?, ?, ?)
      `).run(
        operation.vehicleId,
        req.body.maintenanceDescription,
        stamp.slice(0, 10),
        operation.finalKm,
        req.user.id,
        stamp,
        stamp,
        operation.id
      );
    }
    const openBlocking = row(`
      SELECT id FROM incidents
      WHERE operation_id = ? AND is_void = 0 AND blocks_vehicle = 1 AND status != 'cerrado' LIMIT 1
    `, operation.id);
    if (req.body.result === "aprobada" && openBlocking) {
      return res.status(409).json({ error: "La unidad tiene un incidente bloqueante pendiente" });
    }
    db.prepare(`
      UPDATE operations SET status = 'cerrada', review_result = ?, review_notes = ?,
        reviewed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?
    `).run(req.body.result, req.body.notes || operation.reviewNotes || "", req.user.id, stamp, stamp, operation.id);
    audit(req.user.id, "review", "operation", operation.id, operation, { result: req.body.result, notes: req.body.notes || "" });
    recomputeVehicleStatus(operation.vehicleId);
    res.json(operationDetail(operation.id));
  });

  app.post("/api/operations/:id/cancel", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["reason"]);
    const operation = operationDetail(req.params.id);
    if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
    if (!["borrador", "reservada"].includes(operation.status)) {
      return res.status(409).json({ error: "Una operación iniciada debe cerrarse; no puede cancelarse" });
    }
    db.prepare(`
      UPDATE operations SET status = 'cancelada', cancellation_reason = ?, updated_at = ?, closed_at = ?
      WHERE id = ?
    `).run(req.body.reason, nowIso(), nowIso(), operation.id);
    audit(req.user.id, "cancel", "operation", operation.id, operation, { reason: req.body.reason });
    recomputeVehicleStatus(operation.vehicleId);
    res.json(operationDetail(operation.id));
  });

  app.post(
    "/api/operations/:id/expenses",
    allow("admin", "gestor", "capturista", "chofer"),
    upload.single("receipt"),
    (req, res) => {
      required(req.body, ["expenseDate", "category", "description", "amount"]);
      const operation = operationDetail(req.params.id, req);
      if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
      const stamp = nowIso();
      const result = db.prepare(`
        INSERT INTO operation_expenses
        (operation_id, expense_date, category, description, amount, receipt_path, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id,
        req.body.expenseDate,
        req.body.category,
        req.body.description,
        asNumber(req.body.amount),
        req.file?.path || "",
        req.user.id,
        stamp,
        stamp
      );
      updateOperationCost(operation.id);
      const created = row("SELECT * FROM operation_expenses WHERE id = ?", Number(result.lastInsertRowid));
      audit(req.user.id, "create", "operation_expense", created.id, null, created);
      res.status(201).json(created);
    }
  );

  app.get("/api/operations/:id/ticket.pdf", (req, res) => {
    const operation = operationDetail(req.params.id, req);
    if (!operation) return res.status(404).json({ error: "Operación no encontrada" });
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    res.type("application/pdf").attachment(`${operation.folio}.pdf`);
    doc.pipe(res);
    pdfHeader(doc, "Cuenta y expediente de operación");
    doc.fillColor("#0f172a").fontSize(18).font("Helvetica-Bold").text(operation.folio);
    doc.moveDown(0.4);
    const fields = [
      ["Tipo", operation.operationType.replaceAll("_", " ")],
      ["Estado", operation.status.replaceAll("_", " ")],
      ["Vehículo", `${operation.plate} · ${operation.brand} ${operation.model}`],
      ["Chofer / responsable", operation.driverName || operation.responsibleName || operation.clientName || "Sin asignar"],
      ["Dependencia / cliente", operation.dependencyName || operation.clientName || "Sin registro"],
      ["Destino", operation.destination || "Sin registro"],
      ["Motivo", operation.purpose],
      ["Salida", formatPdfDate(operation.departureAt || operation.plannedStart)],
      ["Retorno", formatPdfDate(operation.returnedAt || operation.plannedEnd)],
      ["Kilómetros", operation.finalKm === null ? `${formatNumber(operation.initialKm)} iniciales` : `${formatNumber(operation.initialKm)} → ${formatNumber(operation.finalKm)} (${formatNumber(operation.finalKm - operation.initialKm)} km)`],
      ["Costo", formatMoney(operation.totalCost)],
      ["Ingreso", formatMoney(operation.income)],
      ["Resultado", formatMoney(operation.income - operation.totalCost)]
    ];
    fields.forEach(([label, value]) => {
      doc.fillColor("#64748b").fontSize(8).font("Helvetica-Bold").text(label.toUpperCase());
      doc.fillColor("#0f172a").fontSize(11).font("Helvetica").text(String(value));
      doc.moveDown(0.55);
    });
    doc.moveDown().fillColor("#64748b").fontSize(8)
      .text(`Combustible: ${operation.fuelVouchers.length} · Incidentes: ${operation.incidents.length} · Gastos: ${operation.expenses.length}`);
    doc.end();
  });

  app.get("/api/vehicle-types", (req, res) => res.json(rows("SELECT * FROM vehicle_types ORDER BY name")));

  app.get("/api/vehicles", (req, res) => {
    recomputeAllVehicleStatuses();
    const query = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    let sql = `
      SELECT v.*, v.operational_status AS status, vt.name AS type_name,
        (SELECT COUNT(*) FROM alerts a WHERE a.entity_type = 'vehicle' AND a.entity_id = v.id AND a.resolved = 0) AS alert_count
      FROM vehicles v LEFT JOIN vehicle_types vt ON vt.id = v.type_id WHERE 1=1
    `;
    const params = [];
    if (query) {
      sql += " AND (v.plate LIKE ? OR v.brand LIKE ? OR v.model LIKE ? OR v.vin LIKE ?)";
      const like = `%${query}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      sql += " AND v.operational_status = ?";
      params.push(status);
    }
    const visibility = vehicleVisibility(req, "v");
    sql += visibility.sql;
    params.push(...visibility.params);
    sql += " ORDER BY v.updated_at DESC";
    res.json(rows(sql, ...params));
  });

  app.post("/api/vehicles", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["plate", "brand", "model"]);
    const stamp = nowIso();
    const result = db.prepare(`
      INSERT INTO vehicles
      (plate, type_id, brand, model, year, vin, photo, color, status, insurer, policy_number,
       insurance_expiry, current_mileage, average_consumption, operational_status,
       allow_administrative, allow_internal, allow_tourism, allow_rental, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(req.body.plate).toUpperCase(),
      asNullableNumber(req.body.typeId),
      req.body.brand,
      req.body.model,
      asNullableNumber(req.body.year),
      req.body.vin || "",
      req.body.photo || "",
      req.body.color || "",
      "disponible",
      req.body.insurer || "",
      req.body.policyNumber || "",
      req.body.insuranceExpiry || null,
      asNumber(req.body.currentMileage),
      asNumber(req.body.averageConsumption),
      "disponible",
      req.body.allowAdministrative === false || req.body.allowAdministrative === "false" ? 0 : 1,
      req.body.allowInternal === false || req.body.allowInternal === "false" ? 0 : 1,
      req.body.allowTourism === true || req.body.allowTourism === "true" || req.body.allowTourism === "on" ? 1 : 0,
      req.body.allowRental === true || req.body.allowRental === "true" || req.body.allowRental === "on" ? 1 : 0,
      stamp,
      stamp
    );
    const created = row("SELECT * FROM vehicles WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "vehicle", created.id, null, created);
    refreshAlerts();
    res.status(201).json(created);
  });

  app.get("/api/vehicles/:id", (req, res) => {
    recomputeVehicleStatus(req.params.id);
    const visibility = vehicleVisibility(req, "v");
    const vehicle = row(`
      SELECT v.*, v.operational_status AS status, vt.name AS type_name FROM vehicles v
      LEFT JOIN vehicle_types vt ON vt.id = v.type_id WHERE v.id = ? ${visibility.sql}
    `, req.params.id, ...visibility.params);
    if (!vehicle) return res.status(404).json({ error: "Vehículo no encontrado" });
    const detail = {
      ...vehicle,
      mileageLogs: rows(`
        SELECT ml.*, d.name AS driver_name, u.name AS created_by_name
        FROM mileage_logs ml
        LEFT JOIN drivers d ON d.id = ml.driver_id
        LEFT JOIN users u ON u.id = ml.created_by
        WHERE ml.vehicle_id = ? AND ml.is_void = 0 ORDER BY ml.departure_at DESC
      `, req.params.id),
      maintenance: rows(`
        SELECT m.*, w.name AS workshop_name FROM maintenance_records m
        LEFT JOIN workshops w ON w.id = m.workshop_id
        WHERE m.vehicle_id = ? AND m.is_void = 0 ORDER BY m.service_date DESC
      `, req.params.id),
      incidents: rows(`
        SELECT i.*, d.name AS driver_name FROM incidents i
        LEFT JOIN drivers d ON d.id = i.driver_id
        WHERE i.vehicle_id = ? AND i.is_void = 0 ORDER BY i.incident_date DESC
      `, req.params.id),
      fuelVouchers: rows(`
        SELECT f.*, d.name AS driver_name FROM fuel_vouchers f
        LEFT JOIN drivers d ON d.id = f.driver_id
        WHERE f.vehicle_id = ? AND f.is_void = 0 ORDER BY f.voucher_date DESC
      `, req.params.id),
      tireChanges: rows(`
        SELECT * FROM tire_changes WHERE vehicle_id = ? AND is_void = 0 ORDER BY change_date DESC
      `, req.params.id),
      custodySheets: rows(`
        SELECT c.*, d.name AS driver_name FROM custody_sheets c
        JOIN drivers d ON d.id = c.driver_id
        WHERE c.vehicle_id = ? AND c.is_void = 0 ORDER BY c.delivered_at DESC
      `, req.params.id),
      documents: rows("SELECT * FROM documents WHERE entity_type = 'vehicle' AND entity_id = ? ORDER BY uploaded_at DESC", req.params.id),
      alerts: rows("SELECT * FROM alerts WHERE entity_type = 'vehicle' AND entity_id = ? AND resolved = 0", req.params.id)
    };
    detail.operations = rows(`
      SELECT o.*, d.name AS driver_name,
        COALESCE(o.final_km - o.initial_km, 0) AS distance_km
      FROM operations o LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.vehicle_id = ? ORDER BY o.created_at DESC
    `, req.params.id);
    detail.timeline = [
      ...detail.operations.map((item) => ({
        date: item.departureAt || item.plannedStart || item.createdAt,
        type: "operacion",
        title: `${item.folio} · ${item.operationType.replaceAll("_", " ")}`,
        detail: `${item.status.replaceAll("_", " ")}${item.driverName ? ` · ${item.driverName}` : ""}`,
        entityId: item.id
      })),
      ...detail.maintenance.filter((item) => !item.isVoid).map((item) => ({
        date: item.serviceDate,
        type: "mantenimiento",
        title: item.serviceType,
        detail: `${item.status} · ${formatMoney(item.cost)}`,
        entityId: item.id
      })),
      ...detail.fuelVouchers.filter((item) => !item.isVoid).map((item) => ({
        date: item.voucherDate,
        type: "combustible",
        title: `${item.liters} L de combustible`,
        detail: `${formatMoney(item.totalCost)} · ${formatNumber(item.mileage)} km`,
        entityId: item.id
      })),
      ...detail.incidents.filter((item) => !item.isVoid).map((item) => ({
        date: item.incidentDate,
        type: "incidente",
        title: item.description,
        detail: `${item.severity || "media"} · ${item.status}`,
        entityId: item.id
      })),
      ...detail.tireChanges.filter((item) => !item.isVoid).map((item) => ({
        date: item.changeDate,
        type: "llantas",
        title: `${item.tireType} · ${item.position}`,
        detail: formatMoney(item.cost),
        entityId: item.id
      }))
    ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    res.json(detail);
  });

  app.put("/api/vehicles/:id", allow("admin", "gestor"), (req, res) => {
    const before = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Vehículo no encontrado" });
    const body = { ...req.body, updatedAt: nowIso() };
    buildUpdate(
      "vehicles",
      ["plate", "typeId", "brand", "model", "year", "vin", "photo", "color", "insurer",
        "policyNumber", "insuranceExpiry", "averageConsumption", "allowAdministrative",
        "allowInternal", "allowTourism", "allowRental", "updatedAt"],
      req.params.id,
      body
    );
    const after = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    audit(req.user.id, "update", "vehicle", after.id, before, after);
    refreshAlerts();
    res.json(after);
  });

  app.delete("/api/vehicles/:id", allow("admin"), (req, res) => {
    const before = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Vehículo no encontrado" });
    const openOperation = row(`
      SELECT folio FROM operations WHERE vehicle_id = ?
      AND status IN ('reservada','activa','pendiente_revision') LIMIT 1
    `, req.params.id);
    if (openOperation) return res.status(409).json({ error: `No puede desactivarse: tiene abierta ${openOperation.folio}` });
    db.prepare(`
      UPDATE vehicles SET status = 'inactivo', operational_status = 'inactivo', updated_at = ? WHERE id = ?
    `).run(nowIso(), req.params.id);
    audit(req.user.id, "deactivate", "vehicle", Number(req.params.id), before, { status: "inactivo" });
    res.status(204).end();
  });

  app.post("/api/vehicles/:id/mileage-adjustment", allow("admin"), (req, res) => {
    required(req.body, ["newMileage", "reason"]);
    const before = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Vehículo no encontrado" });
    const openOperation = row(`
      SELECT folio FROM operations WHERE vehicle_id = ? AND status IN ('activa','pendiente_revision') LIMIT 1
    `, req.params.id);
    if (openOperation) return res.status(409).json({ error: `No puede ajustarse durante ${openOperation.folio}` });
    const newMileage = asNumber(req.body.newMileage);
    db.prepare("UPDATE vehicles SET current_mileage = ?, updated_at = ? WHERE id = ?")
      .run(newMileage, nowIso(), req.params.id);
    const after = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    db.prepare(`
      INSERT INTO record_corrections
      (entity_type, entity_id, reason, previous_data, corrected_data, corrected_by, corrected_at)
      VALUES ('vehicle_mileage', ?, ?, ?, ?, ?, ?)
    `).run(before.id, req.body.reason, JSON.stringify({ currentMileage: before.currentMileage }), JSON.stringify({ currentMileage: newMileage }), req.user.id, nowIso());
    audit(req.user.id, "mileage_adjustment", "vehicle", before.id, before, after);
    res.json(after);
  });

  app.post("/api/vehicles/:id/mileage", allow("admin", "gestor", "chofer"), upload.single("photo"), (req, res) => {
    required(req.body, ["departureAt", "initialKm"]);
    const vehicle = row("SELECT * FROM vehicles WHERE id = ?", req.params.id);
    if (!vehicle) return res.status(404).json({ error: "Vehículo no encontrado" });
    const finalKm = asNullableNumber(req.body.finalKm);
    const initialKm = asNumber(req.body.initialKm);
    if (initialKm < vehicle.currentMileage) return res.status(409).json({ error: `El kilometraje inicial no puede ser menor a ${vehicle.currentMileage}` });
    if (finalKm !== null && finalKm < initialKm) return res.status(400).json({ error: "El kilometraje final no puede ser menor al inicial" });
    if (!req.body.arrivalAt || finalKm === null) {
      return res.status(409).json({ error: "Las salidas abiertas deben registrarse desde una operación con folio" });
    }
    const newMileage = finalKm ?? Math.max(vehicle.currentMileage, initialKm);
    const result = db.prepare(`
      INSERT INTO mileage_logs
      (vehicle_id, driver_id, departure_at, arrival_at, initial_km, final_km, odometer_photo, observations, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      asNullableNumber(req.body.driverId),
      req.body.departureAt,
      req.body.arrivalAt || null,
      initialKm,
      finalKm,
      req.file?.path || "",
      req.body.observations || "",
      req.user.id,
      nowIso()
    );
    db.prepare("UPDATE vehicles SET current_mileage = ?, updated_at = ? WHERE id = ?")
      .run(newMileage, nowIso(), req.params.id);
    audit(req.user.id, "create", "mileage_log", Number(result.lastInsertRowid), null, { vehicleId: Number(req.params.id), initialKm, finalKm });
    refreshAlerts();
    recomputeVehicleStatus(req.params.id);
    res.status(201).json(row("SELECT * FROM mileage_logs WHERE id = ?", Number(result.lastInsertRowid)));
  });

  app.get("/api/drivers", (req, res) => {
    const onlyOwn = req.user.role === "chofer" ? "WHERE d.user_id = ?" : "";
    const params = req.user.role === "chofer" ? [req.user.id] : [];
    res.json(rows(`
      SELECT d.*,
        (SELECT COUNT(*) FROM incidents i WHERE i.driver_id = d.id) AS incident_count,
        (SELECT COUNT(*) FROM mileage_logs ml WHERE ml.driver_id = d.id) AS trip_count,
        (SELECT o.folio FROM operations o WHERE o.driver_id = d.id
          AND o.status IN ('reservada','activa','pendiente_revision') LIMIT 1) AS active_operation_folio
      FROM drivers d ${onlyOwn} ORDER BY d.active DESC, d.name
    `, ...params));
  });

  app.post("/api/drivers", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["name", "phone", "licenseNumber"]);
    const stamp = nowIso();
    const result = db.prepare(`
      INSERT INTO drivers
      (user_id, name, phone, license_number, license_expiry, address, emergency_phone, notes, photo, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asNullableNumber(req.body.userId),
      req.body.name,
      req.body.phone,
      req.body.licenseNumber,
      req.body.licenseExpiry || null,
      req.body.address || "",
      req.body.emergencyPhone || "",
      req.body.notes || "",
      req.body.photo || "",
      req.body.active === false ? 0 : 1,
      stamp,
      stamp
    );
    const created = row("SELECT * FROM drivers WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "driver", created.id, null, created);
    refreshAlerts();
    res.status(201).json(created);
  });

  app.put("/api/drivers/:id", allow("admin", "gestor"), (req, res) => {
    const before = row("SELECT * FROM drivers WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Chofer no encontrado" });
    buildUpdate(
      "drivers",
      ["userId", "name", "phone", "licenseNumber", "licenseExpiry", "address", "emergencyPhone", "notes", "photo", "active", "updatedAt"],
      req.params.id,
      { ...req.body, updatedAt: nowIso() }
    );
    const after = row("SELECT * FROM drivers WHERE id = ?", req.params.id);
    audit(req.user.id, "update", "driver", after.id, before, after);
    refreshAlerts();
    res.json(after);
  });

  app.delete("/api/drivers/:id", allow("admin"), (req, res) => {
    const before = row("SELECT * FROM drivers WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Chofer no encontrado" });
    db.prepare("UPDATE drivers SET active = 0, updated_at = ? WHERE id = ?").run(nowIso(), req.params.id);
    audit(req.user.id, "deactivate", "driver", Number(req.params.id), before, { active: 0 });
    res.status(204).end();
  });

  app.get("/api/drivers/:id/badge.pdf", (req, res) => {
    const driver = row("SELECT * FROM drivers WHERE id = ?", req.params.id);
    if (!driver) return res.status(404).json({ error: "Chofer no encontrado" });
    const settings = row("SELECT * FROM settings WHERE id = 1");
    const doc = new PDFDocument({ size: [360, 540], margin: 30 });
    res.type("application/pdf").attachment(`gafete-${driver.licenseNumber}.pdf`);
    doc.pipe(res);
    doc.rect(0, 0, 360, 540).fill("#071521");
    doc.roundedRect(20, 20, 320, 500, 22).fill("#0f2536");
    doc.fillColor("#2dd4bf").fontSize(12).font("Helvetica-Bold").text("PERSONAL AUTORIZADO", 40, 48, { align: "center", width: 280 });
    doc.fillColor("#ffffff").fontSize(22).text(settings.companyName, 40, 82, { align: "center", width: 280 });
    doc.circle(180, 205, 58).fill("#17394d");
    doc.fillColor("#5eead4").fontSize(38).text(driver.name.split(" ").map((word) => word[0]).slice(0, 2).join(""), 122, 185, { align: "center", width: 116 });
    doc.fillColor("#ffffff").fontSize(20).text(driver.name, 45, 290, { align: "center", width: 270 });
    doc.fillColor("#94a3b8").fontSize(11).font("Helvetica").text("CHOFER AUTORIZADO", 45, 324, { align: "center", width: 270 });
    doc.fillColor("#e2e8f0").fontSize(11).text(`Licencia: ${driver.licenseNumber}`, 55, 370);
    doc.text(`Vigencia: ${driver.licenseExpiry || "Sin fecha"}`, 55, 392);
    doc.text(`Teléfono: ${driver.phone}`, 55, 414);
    doc.fillColor(driver.active ? "#34d399" : "#fb7185").font("Helvetica-Bold").text(driver.active ? "ACTIVO" : "INACTIVO", 55, 458);
    doc.end();
  });

  app.get("/api/workshops", (req, res) => res.json(rows(`
    SELECT w.*, (SELECT COUNT(*) FROM maintenance_records m WHERE m.workshop_id = w.id) AS service_count
    FROM workshops w ORDER BY w.name
  `)));

  app.post("/api/workshops", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["name"]);
    const result = db.prepare(`
      INSERT INTO workshops (name, address, phone, contact, email, services, standard_rates, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.body.name, req.body.address || "", req.body.phone || "", req.body.contact || "", req.body.email || "", req.body.services || "", req.body.standardRates || "", nowIso());
    const created = row("SELECT * FROM workshops WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "workshop", created.id, null, created);
    res.status(201).json(created);
  });

  app.put("/api/workshops/:id", allow("admin", "gestor"), (req, res) => {
    const before = row("SELECT * FROM workshops WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Taller no encontrado" });
    buildUpdate("workshops", ["name", "address", "phone", "contact", "email", "services", "standardRates"], req.params.id, req.body);
    const after = row("SELECT * FROM workshops WHERE id = ?", req.params.id);
    audit(req.user.id, "update", "workshop", after.id, before, after);
    res.json(after);
  });

  app.get("/api/maintenance", (req, res) => {
    const status = String(req.query.status || "");
    const vehicleId = asNullableNumber(req.query.vehicleId);
    let sql = `
      SELECT m.*, v.plate, v.brand, v.model, w.name AS workshop_name
      FROM maintenance_records m
      JOIN vehicles v ON v.id = m.vehicle_id
      LEFT JOIN workshops w ON w.id = m.workshop_id WHERE 1=1
    `;
    const params = [];
    if (status) { sql += " AND m.status = ?"; params.push(status); }
    if (vehicleId) { sql += " AND m.vehicle_id = ?"; params.push(vehicleId); }
    sql += " ORDER BY CASE m.status WHEN 'en_proceso' THEN 1 WHEN 'abierta' THEN 2 ELSE 3 END, m.service_date DESC";
    res.json(rows(sql, ...params));
  });

  app.post("/api/maintenance", allow("admin", "gestor", "capturista", "taller"), upload.single("invoice"), (req, res) => {
    required(req.body, ["vehicleId", "serviceType", "description", "serviceDate"]);
    const stamp = nowIso();
    const result = db.prepare(`
      INSERT INTO maintenance_records
      (vehicle_id, service_type, description, workshop_id, service_date, cost, mileage, invoice_path,
       next_service_km, next_service_date, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.vehicleId,
      req.body.serviceType,
      req.body.description,
      asNullableNumber(req.body.workshopId),
      req.body.serviceDate,
      asNumber(req.body.cost),
      asNumber(req.body.mileage),
      req.file?.path || "",
      asNullableNumber(req.body.nextServiceKm),
      req.body.nextServiceDate || null,
      req.body.status || "abierta",
      req.user.id,
      stamp,
      stamp
    );
    const created = row("SELECT * FROM maintenance_records WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "maintenance", created.id, null, created);
    recomputeVehicleStatus(req.body.vehicleId);
    refreshAlerts();
    res.status(201).json(created);
  });

  app.put("/api/maintenance/:id", allow("admin", "gestor", "taller"), (req, res) => {
    const before = row("SELECT * FROM maintenance_records WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Orden no encontrada" });
    buildUpdate(
      "maintenance_records",
      ["serviceType", "description", "workshopId", "serviceDate", "cost", "mileage", "nextServiceKm", "nextServiceDate", "status", "updatedAt"],
      req.params.id,
      { ...req.body, updatedAt: nowIso() }
    );
    const after = row("SELECT * FROM maintenance_records WHERE id = ?", req.params.id);
    audit(req.user.id, "update", "maintenance", after.id, before, after);
    if (after.operationId) updateOperationCost(after.operationId);
    recomputeVehicleStatus(after.vehicleId);
    refreshAlerts();
    res.json(after);
  });

  app.post("/api/incidents", allow("admin", "gestor", "capturista", "chofer"), upload.single("photo"), (req, res) => {
    required(req.body, ["vehicleId", "incidentDate", "description"]);
    const result = db.prepare(`
      INSERT INTO incidents
      (vehicle_id, driver_id, incident_date, description, photo_path, cost, status, created_by,
       created_at, operation_id, severity, blocks_vehicle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.vehicleId,
      asNullableNumber(req.body.driverId),
      req.body.incidentDate,
      req.body.description,
      req.file?.path || "",
      asNumber(req.body.cost),
      req.body.status || "abierto",
      req.user.id,
      nowIso(),
      asNullableNumber(req.body.operationId),
      req.body.severity || "media",
      req.body.blocksVehicle === "true" || req.body.blocksVehicle === "on" ? 1 : 0
    );
    const created = row("SELECT * FROM incidents WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "incident", created.id, null, created);
    if (created.operationId) updateOperationCost(created.operationId);
    recomputeVehicleStatus(created.vehicleId);
    res.status(201).json(created);
  });

  app.get("/api/incidents", (req, res) => res.json(rows(`
    SELECT i.*, v.plate, d.name AS driver_name FROM incidents i
    JOIN vehicles v ON v.id = i.vehicle_id
    LEFT JOIN drivers d ON d.id = i.driver_id
    ORDER BY i.incident_date DESC
  `)));

  app.post("/api/fuel-vouchers", allow("admin", "gestor", "capturista", "chofer"), upload.single("signature"), (req, res) => {
    required(req.body, ["vehicleId", "voucherDate", "liters", "totalCost", "mileage"]);
    const result = db.prepare(`
      INSERT INTO fuel_vouchers
      (vehicle_id, driver_id, voucher_date, liters, total_cost, mileage, supplier, note,
       signature_path, created_by, created_at, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.vehicleId,
      asNullableNumber(req.body.driverId),
      req.body.voucherDate,
      asNumber(req.body.liters),
      asNumber(req.body.totalCost),
      asNumber(req.body.mileage),
      req.body.supplier || "",
      req.body.note || "",
      req.file?.path || "",
      req.user.id,
      nowIso(),
      asNullableNumber(req.body.operationId)
    );
    const created = row("SELECT * FROM fuel_vouchers WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "fuel_voucher", created.id, null, created);
    if (created.operationId) updateOperationCost(created.operationId);
    res.status(201).json(created);
  });

  app.get("/api/fuel-vouchers", (req, res) => res.json(rows(`
    SELECT f.*, v.plate, d.name AS driver_name
    FROM fuel_vouchers f JOIN vehicles v ON v.id = f.vehicle_id
    LEFT JOIN drivers d ON d.id = f.driver_id
    ORDER BY f.voucher_date DESC
  `)));

  app.get("/api/fuel-vouchers/:id/receipt.pdf", (req, res) => {
    const voucher = row(`
      SELECT f.*, v.plate, v.brand, v.model, d.name AS driver_name
      FROM fuel_vouchers f JOIN vehicles v ON v.id = f.vehicle_id
      LEFT JOIN drivers d ON d.id = f.driver_id WHERE f.id = ?
    `, req.params.id);
    if (!voucher) return res.status(404).json({ error: "Vale no encontrado" });
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    res.type("application/pdf").attachment(`vale-gasolina-${voucher.id}.pdf`);
    doc.pipe(res);
    pdfHeader(doc, "Vale de gasolina");
    const fields = [
      ["Folio", String(voucher.id).padStart(6, "0")],
      ["Fecha", formatPdfDate(voucher.voucherDate)],
      ["Vehículo", `${voucher.plate} · ${voucher.brand} ${voucher.model}`],
      ["Chofer", voucher.driverName || "Sin asignar"],
      ["Litros", `${voucher.liters} L`],
      ["Costo total", `$${Number(voucher.totalCost).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`],
      ["Kilometraje", `${Number(voucher.mileage).toLocaleString("es-MX")} km`],
      ["Proveedor", voucher.supplier || "Sin registro"],
      ["Nota", voucher.note || "Sin observaciones"]
    ];
    fields.forEach(([label, value]) => {
      doc.fillColor("#64748b").fontSize(8).font("Helvetica-Bold").text(label.toUpperCase());
      doc.fillColor("#0f172a").fontSize(12).font("Helvetica").text(value);
      doc.moveDown(0.8);
    });
    doc.moveDown().strokeColor("#cbd5e1").moveTo(72, doc.y).lineTo(300, doc.y).stroke();
    doc.fillColor("#64748b").fontSize(8).text("FIRMA DEL CHOFER", 72, doc.y + 8);
    doc.end();
  });

  app.post("/api/tire-changes", allow("admin", "gestor", "capturista", "taller"), (req, res) => {
    required(req.body, ["vehicleId", "changeDate", "tireType", "position"]);
    const result = db.prepare(`
      INSERT INTO tire_changes
      (vehicle_id, change_date, tire_type, position, cost, supplier, mileage, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.vehicleId,
      req.body.changeDate,
      req.body.tireType,
      req.body.position,
      asNumber(req.body.cost),
      req.body.supplier || "",
      asNumber(req.body.mileage),
      asNullableNumber(req.body.operationId)
    );
    const created = row("SELECT * FROM tire_changes WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "tire_change", created.id, null, created);
    res.status(201).json(created);
  });

  app.post("/api/custody-sheets", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["vehicleId", "driverId", "deliveredAt", "deliveryKm"]);
    const existing = row(`
      SELECT id FROM custody_sheets WHERE vehicle_id = ? AND returned_at IS NULL AND is_void = 0 LIMIT 1
    `, req.body.vehicleId);
    if (existing) return res.status(409).json({ error: "La unidad ya tiene un resguardo abierto" });
    assertDriverCanOperate(req.body.driverId);
    const result = db.prepare(`
      INSERT INTO custody_sheets
      (vehicle_id, driver_id, delivered_at, returned_at, delivery_km, return_km, observations, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.vehicleId,
      req.body.driverId,
      req.body.deliveredAt,
      req.body.returnedAt || null,
      asNumber(req.body.deliveryKm),
      asNullableNumber(req.body.returnKm),
      req.body.observations || "",
      req.user.id,
      nowIso()
    );
    db.prepare("UPDATE vehicles SET current_mileage = MAX(current_mileage, ?), updated_at = ? WHERE id = ?")
      .run(asNullableNumber(req.body.returnKm) ?? asNumber(req.body.deliveryKm), nowIso(), req.body.vehicleId);
    const created = row("SELECT * FROM custody_sheets WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "create", "custody_sheet", created.id, null, created);
    recomputeVehicleStatus(req.body.vehicleId);
    res.status(201).json(created);
  });

  app.put("/api/custody-sheets/:id/return", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["returnedAt", "returnKm"]);
    const before = row("SELECT * FROM custody_sheets WHERE id = ?", req.params.id);
    if (!before) return res.status(404).json({ error: "Hoja de resguardo no encontrada" });
    if (asNumber(req.body.returnKm) < before.deliveryKm) return res.status(400).json({ error: "El kilometraje de retorno no puede ser menor al de entrega" });
    db.prepare("UPDATE custody_sheets SET returned_at = ?, return_km = ?, observations = ? WHERE id = ?")
      .run(req.body.returnedAt, asNumber(req.body.returnKm), req.body.observations ?? before.observations, req.params.id);
    db.prepare("UPDATE vehicles SET current_mileage = ?, updated_at = ? WHERE id = ?")
      .run(asNumber(req.body.returnKm), nowIso(), before.vehicleId);
    const after = row("SELECT * FROM custody_sheets WHERE id = ?", req.params.id);
    audit(req.user.id, "return", "custody_sheet", after.id, before, after);
    recomputeVehicleStatus(before.vehicleId);
    res.json(after);
  });

  app.get("/api/custody-sheets/:id/pdf", (req, res) => {
    const sheet = row(`
      SELECT c.*, v.plate, v.brand, v.model, v.vin, v.color, d.name AS driver_name,
        d.license_number, d.phone AS driver_phone
      FROM custody_sheets c JOIN vehicles v ON v.id = c.vehicle_id
      JOIN drivers d ON d.id = c.driver_id WHERE c.id = ?
    `, req.params.id);
    if (!sheet) return res.status(404).json({ error: "Hoja de resguardo no encontrada" });
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    res.type("application/pdf").attachment(`resguardo-${sheet.plate}-${sheet.id}.pdf`);
    doc.pipe(res);
    pdfHeader(doc, "Hoja de resguardo vehicular");
    doc.fillColor("#475569").fontSize(10).text(`Folio: ${String(sheet.id).padStart(6, "0")}`, { align: "right" });
    doc.moveDown();
    const fields = [
      ["Vehículo", `${sheet.plate} · ${sheet.brand} ${sheet.model}`],
      ["VIN", sheet.vin || "Sin registro"],
      ["Color", sheet.color || "Sin registro"],
      ["Persona resguardante", sheet.driverName],
      ["Licencia", sheet.licenseNumber],
      ["Teléfono", sheet.driverPhone],
      ["Fecha de entrega", formatPdfDate(sheet.deliveredAt)],
      ["Kilometraje de entrega", `${Number(sheet.deliveryKm).toLocaleString("es-MX")} km`],
      ["Fecha de retorno", sheet.returnedAt ? formatPdfDate(sheet.returnedAt) : "Pendiente"],
      ["Kilometraje de retorno", sheet.returnKm ? `${Number(sheet.returnKm).toLocaleString("es-MX")} km` : "Pendiente"],
      ["Observaciones", sheet.observations || "Sin observaciones"]
    ];
    fields.forEach(([label, value]) => {
      doc.fillColor("#64748b").fontSize(8).font("Helvetica-Bold").text(label.toUpperCase());
      doc.fillColor("#0f172a").fontSize(11).font("Helvetica").text(value);
      doc.moveDown(0.55);
    });
    const signatureY = Math.max(doc.y + 55, 620);
    doc.strokeColor("#94a3b8").moveTo(72, signatureY).lineTo(270, signatureY).stroke();
    doc.moveTo(330, signatureY).lineTo(528, signatureY).stroke();
    doc.fillColor("#64748b").fontSize(8).text("ENTREGA", 72, signatureY + 8, { width: 198, align: "center" });
    doc.text("RECIBE", 330, signatureY + 8, { width: 198, align: "center" });
    doc.end();
  });

  app.post("/api/documents/upload", allow("admin", "gestor", "capturista", "taller"), upload.single("document"), (req, res) => {
    required(req.body, ["entityType", "entityId", "documentType"]);
    if (!req.file) return res.status(400).json({ error: "Selecciona un archivo" });
    const result = db.prepare(`
      INSERT INTO documents
      (entity_type, entity_id, document_type, original_name, stored_name, filepath, mime_type, size_bytes, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.entityType,
      req.body.entityId,
      req.body.documentType,
      req.file.originalname,
      req.file.filename,
      req.file.path,
      req.file.mimetype,
      req.file.size,
      req.user.id,
      nowIso()
    );
    const created = row("SELECT * FROM documents WHERE id = ?", Number(result.lastInsertRowid));
    audit(req.user.id, "upload", "document", created.id, null, { originalName: created.originalName, entityType: created.entityType, entityId: created.entityId });
    res.status(201).json(created);
  });

  app.get("/api/documents/:id/download", (req, res) => {
    const document = row("SELECT * FROM documents WHERE id = ?", req.params.id);
    if (!document || !fs.existsSync(document.filepath)) return res.status(404).json({ error: "Documento no encontrado" });
    res.download(document.filepath, document.originalName);
  });

  app.post("/api/notifications/whatsapp", (req, res) => {
    required(req.body, ["vehicleId", "driverId"]);
    const vehicle = row("SELECT * FROM vehicles WHERE id = ?", req.body.vehicleId);
    const driver = row("SELECT * FROM drivers WHERE id = ?", req.body.driverId);
    if (!vehicle || !driver) return res.status(404).json({ error: "Vehículo o chofer no encontrado" });
    const date = req.body.dateTime || new Date().toLocaleString("es-MX");
    const km = req.body.km ?? vehicle.currentMileage;
    const message = req.body.message || `Hola ${driver.name}, se te asignó el vehículo ${vehicle.plate} (${vehicle.brand} ${vehicle.model}). Fecha/hora: ${date}. Km inicio: ${km}. Por favor confirma.`;
    const phone = String(driver.phone).replace(/\D/g, "");
    const link = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    const result = db.prepare(`
      INSERT INTO whatsapp_logs (vehicle_id, driver_id, phone, message, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'intentado', ?, ?)
    `).run(vehicle.id, driver.id, phone, message, req.user.id, nowIso());
    audit(req.user.id, "whatsapp_link", "whatsapp_log", Number(result.lastInsertRowid), null, { vehicleId: vehicle.id, driverId: driver.id });
    res.json({ link, message, status: "intentado" });
  });

  app.get("/api/alerts", (req, res) => {
    refreshAlerts();
    res.json(rows("SELECT * FROM alerts WHERE resolved = 0 ORDER BY severity, due_date"));
  });

  app.post("/api/records/:entity/:id/void", allow("admin", "gestor"), (req, res) => {
    required(req.body, ["reason"]);
    const entities = {
      mileage: { table: "mileage_logs", vehicle: "vehicle_id", operation: "operation_id" },
      maintenance: { table: "maintenance_records", vehicle: "vehicle_id", operation: "operation_id" },
      tire: { table: "tire_changes", vehicle: "vehicle_id", operation: "operation_id" },
      incident: { table: "incidents", vehicle: "vehicle_id", operation: "operation_id" },
      custody: { table: "custody_sheets", vehicle: "vehicle_id", operation: "operation_id" },
      fuel: { table: "fuel_vouchers", vehicle: "vehicle_id", operation: "operation_id" },
      expense: { table: "operation_expenses", vehicle: null, operation: "operation_id" }
    };
    const config = entities[req.params.entity];
    if (!config) return res.status(400).json({ error: "Tipo de registro no anulable" });
    const before = row(`SELECT * FROM ${config.table} WHERE id = ?`, req.params.id);
    if (!before) return res.status(404).json({ error: "Registro no encontrado" });
    if (before.isVoid) return res.status(409).json({ error: "El registro ya está anulado" });
    db.prepare(`UPDATE ${config.table} SET is_void = 1, void_reason = ? WHERE id = ?`)
      .run(req.body.reason, req.params.id);
    const after = row(`SELECT * FROM ${config.table} WHERE id = ?`, req.params.id);
    db.prepare(`
      INSERT INTO record_corrections
      (entity_type, entity_id, reason, previous_data, corrected_data, corrected_by, corrected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.entity, before.id, req.body.reason, JSON.stringify(before), JSON.stringify(after), req.user.id, nowIso());
    audit(req.user.id, "void", req.params.entity, before.id, before, after);
    const operationId = config.operation ? before[config.operation.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] : null;
    const vehicleId = config.vehicle ? before[config.vehicle.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] : null;
    if (operationId) updateOperationCost(operationId);
    if (vehicleId) recomputeVehicleStatus(vehicleId);
    res.json(after);
  });

  app.get("/api/audit", allow("admin", "gestor", "auditor"), (req, res) => {
    res.json(rows(`
      SELECT a.*, u.name AS user_name, u.role AS user_role
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 250
    `));
  });

  app.get("/api/users", allow("admin"), (req, res) => res.json(rows(`
    SELECT id, name, username, email, role, phone, active, must_change_password, created_at, updated_at
    FROM users ORDER BY active DESC, name
  `)));

  app.post("/api/users", allow("admin"), (req, res) => {
    required(req.body, ["name", "username", "email", "password", "role"]);
    if (!["admin", "gestor", "taller", "chofer", "capturista", "auditor"].includes(req.body.role)) {
      return res.status(400).json({ error: "Rol inválido" });
    }
    const { salt, hash } = hashPassword(req.body.password);
    const stamp = nowIso();
    const result = db.prepare(`
      INSERT INTO users
      (name, username, email, password_hash, password_salt, role, phone, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(req.body.name, req.body.username.toLowerCase(), req.body.email.toLowerCase(), hash, salt, req.body.role, req.body.phone || "", stamp, stamp);
    const created = row(`
      SELECT id, name, username, email, role, phone, active, must_change_password FROM users WHERE id = ?
    `, Number(result.lastInsertRowid));
    audit(req.user.id, "create", "user", created.id, null, created);
    res.status(201).json(created);
  });

  app.get("/api/settings", (req, res) => res.json(row("SELECT * FROM settings WHERE id = 1")));

  app.put("/api/settings", allow("admin"), (req, res) => {
    required(req.body, ["confirmPassword"]);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!verifyPassword(req.body.confirmPassword, user.password_salt, user.password_hash)) return res.status(403).json({ error: "Contraseña de administrador incorrecta" });
    const before = row("SELECT * FROM settings WHERE id = 1");
    buildUpdate(
      "settings",
      ["companyName", "companyPhone", "companyAddress", "logoUrl", "alertDays", "alertKm", "updatedAt"],
      1,
      { ...req.body, updatedAt: nowIso() }
    );
    const after = row("SELECT * FROM settings WHERE id = 1");
    audit(req.user.id, "update", "settings", 1, before, after);
    refreshAlerts();
    res.json(after);
  });

  app.get("/api/reports", (req, res) => {
    const type = String(req.query.type || "maintenance");
    const format = String(req.query.format || "csv");
    const dateFrom = req.query.dateFrom || "1900-01-01";
    const dateTo = req.query.dateTo || "2999-12-31";
    let records;
    let title;
    if (type === "operations") {
      title = "Reporte integral de operaciones";
      records = rows(`
        SELECT o.folio AS folio, o.operation_type AS tipo, o.status AS estado,
          v.plate AS placa, v.brand || ' ' || v.model AS vehiculo,
          COALESCE(d.name, o.responsible_name, o.client_name) AS responsable,
          o.destination AS destino, o.planned_start AS fecha_programada,
          o.departure_at AS salida, o.returned_at AS retorno,
          COALESCE(o.final_km - o.initial_km, 0) AS km_recorridos,
          o.total_cost AS costo, o.income AS ingreso,
          o.income - o.total_cost AS resultado
        FROM operations o JOIN vehicles v ON v.id = o.vehicle_id
        LEFT JOIN drivers d ON d.id = o.driver_id
        WHERE date(o.planned_start) BETWEEN ? AND ?
        ORDER BY o.planned_start DESC
      `, dateFrom, dateTo);
    } else if (type === "profitability") {
      title = "Rentabilidad y costo por vehículo";
      records = rows(`
        SELECT v.plate AS placa, v.brand || ' ' || v.model AS vehiculo,
          COUNT(o.id) AS operaciones,
          COALESCE(SUM(o.final_km - o.initial_km), 0) AS km_recorridos,
          COALESCE(SUM(o.total_cost), 0) AS costo_total,
          CASE WHEN COALESCE(SUM(o.final_km - o.initial_km), 0) > 0
            THEN ROUND(SUM(o.total_cost) / SUM(o.final_km - o.initial_km), 2) ELSE 0 END AS costo_por_km,
          COALESCE(SUM(o.income), 0) AS ingreso_total,
          COALESCE(SUM(o.income - o.total_cost), 0) AS utilidad
        FROM vehicles v LEFT JOIN operations o ON o.vehicle_id = v.id
          AND date(o.planned_start) BETWEEN ? AND ?
          AND o.status = 'cerrada'
        GROUP BY v.id ORDER BY costo_total DESC
      `, dateFrom, dateTo);
    } else if (type === "mileage") {
      title = "Reporte de kilometraje";
      records = rows(`
        SELECT v.plate AS placa, v.brand || ' ' || v.model AS vehiculo, d.name AS chofer,
          ml.departure_at AS salida, ml.arrival_at AS llegada, ml.initial_km AS km_inicial,
          ml.final_km AS km_final, COALESCE(ml.final_km - ml.initial_km, 0) AS km_recorridos,
          ml.observations AS observaciones
        FROM mileage_logs ml JOIN vehicles v ON v.id = ml.vehicle_id
        LEFT JOIN drivers d ON d.id = ml.driver_id
        WHERE date(ml.departure_at) BETWEEN ? AND ? AND ml.is_void = 0 ORDER BY ml.departure_at DESC
      `, dateFrom, dateTo);
    } else if (type === "fuel") {
      title = "Reporte de combustible";
      records = rows(`
        SELECT v.plate AS placa, d.name AS chofer, f.voucher_date AS fecha, f.liters AS litros,
          f.total_cost AS costo_total, f.mileage AS kilometraje, f.supplier AS proveedor
        FROM fuel_vouchers f JOIN vehicles v ON v.id = f.vehicle_id
        LEFT JOIN drivers d ON d.id = f.driver_id
        WHERE f.voucher_date BETWEEN ? AND ? AND f.is_void = 0 ORDER BY f.voucher_date DESC
      `, dateFrom, dateTo);
    } else {
      title = "Reporte de mantenimientos";
      records = rows(`
        SELECT v.plate AS placa, v.brand || ' ' || v.model AS vehiculo, m.service_type AS servicio,
          m.description AS descripcion, w.name AS taller, m.service_date AS fecha, m.cost AS costo,
          m.mileage AS kilometraje, m.status AS estado
        FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
        LEFT JOIN workshops w ON w.id = m.workshop_id
        WHERE m.service_date BETWEEN ? AND ? AND m.is_void = 0 ORDER BY m.service_date DESC
      `, dateFrom, dateTo);
    }
    audit(req.user.id, "export", "report", null, null, { type, format, dateFrom, dateTo });
    if (format === "pdf") {
      const doc = new PDFDocument({ size: "LETTER", margin: 54 });
      res.type("application/pdf").attachment(`${type}-${dateFrom}-${dateTo}.pdf`);
      doc.pipe(res);
      pdfHeader(doc, title);
      doc.fillColor("#64748b").fontSize(9).text(`Periodo: ${dateFrom} a ${dateTo} · Registros: ${records.length}`);
      doc.moveDown();
      records.forEach((record, index) => {
        if (doc.y > 690) doc.addPage();
        doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(10).text(`${index + 1}. ${record.placa || "Registro"}`);
        doc.font("Helvetica").fontSize(8).fillColor("#475569")
          .text(Object.entries(record).filter(([key]) => key !== "placa").map(([key, value]) => `${key.replaceAll("_", " ")}: ${value ?? "—"}`).join("  ·  "), { width: 468 });
        doc.moveDown(0.6);
      });
      doc.end();
      return;
    }
    sendCsv(res, `${type}-${dateFrom}-${dateTo}.csv`, records);
  });

  const backupTables = [
    "users", "vehicle_types", "vehicles", "drivers", "workshops", "operations", "mileage_logs",
    "maintenance_records", "tire_changes", "incidents", "custody_sheets", "fuel_vouchers",
    "operation_expenses", "documents", "alerts", "whatsapp_logs", "audit_logs",
    "record_corrections", "settings"
  ];

  app.get("/api/backup/full", allow("admin"), (req, res, next) => {
    try {
      db.exec("PRAGMA wal_checkpoint(FULL)");
      const filename = `respaldo-completo-flotilla-${new Date().toISOString().slice(0, 10)}.zip`;
      res.attachment(filename);
      res.type("application/zip");
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", next);
      archive.pipe(res);
      archive.file(dbPath, { name: "data/flotilla.sqlite" });
      if (fs.existsSync(uploadDir)) archive.directory(uploadDir, "uploads");
      archive.append(JSON.stringify({
        product: "control-flotilla",
        version: 2,
        createdAt: nowIso(),
        includes: ["database", "photos", "documents", "signatures", "receipts"]
      }, null, 2), { name: "MANIFIESTO.json" });
      audit(req.user.id, "full_backup", "database", null);
      archive.finalize();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/backup", allow("admin"), (req, res) => {
    const data = Object.fromEntries(backupTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    audit(req.user.id, "backup", "database", null);
    res.attachment(`respaldo-flotilla-${new Date().toISOString().slice(0, 10)}.json`).json({
      product: "control-flotilla",
      version: 2,
      createdAt: nowIso(),
      data
    });
  });

  app.post("/api/backup/restore", allow("admin"), (req, res) => {
    required(req.body, ["confirmPassword", "backup"]);
    const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!verifyPassword(req.body.confirmPassword, currentUser.password_salt, currentUser.password_hash)) return res.status(403).json({ error: "Contraseña de administrador incorrecta" });
    const backup = req.body.backup;
    if (backup.product !== "control-flotilla" || !backup.data) return res.status(400).json({ error: "El archivo no es un respaldo válido" });
    const reverseTables = [...backupTables].reverse();
    db.exec("PRAGMA foreign_keys = OFF; BEGIN");
    try {
      reverseTables.forEach((table) => db.prepare(`DELETE FROM ${table}`).run());
      backupTables.forEach((table) => {
        const tableRows = Array.isArray(backup.data[table]) ? backup.data[table] : [];
        const validColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
        tableRows.forEach((record) => {
          const columns = Object.keys(record).filter((column) => validColumns.has(column));
          if (!columns.length) return;
          const placeholders = columns.map(() => "?").join(",");
          db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`).run(...columns.map((column) => record[column]));
        });
      });
      db.exec("COMMIT; PRAGMA foreign_keys = ON");
      audit(req.user.id, "restore", "database", null);
      refreshAlerts();
      res.json({ message: "Respaldo restaurado correctamente" });
    } catch (error) {
      db.exec("ROLLBACK; PRAGMA foreign_keys = ON");
      throw error;
    }
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada" }));

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Ya existe un registro con ese dato único" });
    if (error.code?.startsWith("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "El registro está relacionado con otros datos y no puede eliminarse" });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: `Archivo inválido: ${error.message}` });
    res.status(error.status || 500).json({ error: error.message || "Error interno" });
  });

  return app;
}

export const app = createApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Control de Flotilla disponible en http://localhost:${port}`);
  });
  const alertTimer = setInterval(() => {
    try {
      refreshAlerts();
    } catch (error) {
      console.error("No fue posible actualizar alertas", error);
    }
  }, 60 * 60 * 1000);
  alertTimer.unref();
}
