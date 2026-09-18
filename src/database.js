import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./security.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.resolve(moduleDir, "../data/flotilla.sqlite");
export const dbPath = path.resolve(process.env.FLEET_DB_PATH || defaultPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

export function nowIso() {
  return new Date().toISOString();
}

export function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','gestor','taller','chofer','capturista','auditor')),
      phone TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicle_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL UNIQUE,
      type_id INTEGER REFERENCES vehicle_types(id),
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      vin TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      color TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'disponible'
        CHECK(status IN ('disponible','en_uso','taller','inactivo')),
      insurer TEXT DEFAULT '',
      policy_number TEXT DEFAULT '',
      insurance_expiry TEXT,
      current_mileage INTEGER NOT NULL DEFAULT 0,
      average_consumption REAL NOT NULL DEFAULT 0,
      operational_status TEXT NOT NULL DEFAULT 'disponible',
      allow_administrative INTEGER NOT NULL DEFAULT 1,
      allow_internal INTEGER NOT NULL DEFAULT 1,
      allow_tourism INTEGER NOT NULL DEFAULT 0,
      allow_rental INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      license_number TEXT NOT NULL UNIQUE,
      license_expiry TEXT,
      address TEXT DEFAULT '',
      emergency_phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workshops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      contact TEXT DEFAULT '',
      email TEXT DEFAULT '',
      services TEXT DEFAULT '',
      standard_rates TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mileage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      driver_id INTEGER REFERENCES drivers(id),
      departure_at TEXT NOT NULL,
      arrival_at TEXT,
      initial_km INTEGER NOT NULL,
      final_km INTEGER,
      odometer_photo TEXT DEFAULT '',
      observations TEXT DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maintenance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL,
      description TEXT NOT NULL,
      workshop_id INTEGER REFERENCES workshops(id),
      service_date TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      mileage INTEGER NOT NULL DEFAULT 0,
      invoice_path TEXT DEFAULT '',
      next_service_km INTEGER,
      next_service_date TEXT,
      status TEXT NOT NULL DEFAULT 'abierta'
        CHECK(status IN ('abierta','en_proceso','completada','cancelada')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tire_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      change_date TEXT NOT NULL,
      tire_type TEXT NOT NULL,
      position TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      supplier TEXT DEFAULT '',
      mileage INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      driver_id INTEGER REFERENCES drivers(id),
      incident_date TEXT NOT NULL,
      description TEXT NOT NULL,
      photo_path TEXT DEFAULT '',
      cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'abierto',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custody_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES drivers(id),
      delivered_at TEXT NOT NULL,
      returned_at TEXT,
      delivery_km INTEGER NOT NULL,
      return_km INTEGER,
      observations TEXT DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fuel_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      driver_id INTEGER REFERENCES drivers(id),
      voucher_date TEXT NOT NULL,
      liters REAL NOT NULL,
      total_cost REAL NOT NULL,
      mileage INTEGER NOT NULL,
      supplier TEXT DEFAULT '',
      note TEXT DEFAULT '',
      signature_path TEXT DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      due_date TEXT,
      due_km INTEGER,
      severity TEXT NOT NULL DEFAULT 'media',
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER REFERENCES vehicles(id),
      driver_id INTEGER REFERENCES drivers(id),
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'intentado',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      before_data TEXT,
      after_data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      company_name TEXT NOT NULL DEFAULT 'NovaFlota',
      company_phone TEXT DEFAULT '',
      company_address TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      alert_days INTEGER NOT NULL DEFAULT 30,
      alert_km INTEGER NOT NULL DEFAULT 1000,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folio TEXT UNIQUE,
      operation_type TEXT NOT NULL CHECK(operation_type IN
        ('comision','uso_interno','transporte_turistico','renta','resguardo','traslado_taller')),
      status TEXT NOT NULL DEFAULT 'reservada' CHECK(status IN
        ('borrador','reservada','activa','pendiente_revision','cerrada','cancelada')),
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      driver_id INTEGER REFERENCES drivers(id),
      responsible_name TEXT DEFAULT '',
      client_name TEXT DEFAULT '',
      dependency_name TEXT DEFAULT '',
      destination TEXT DEFAULT '',
      purpose TEXT NOT NULL,
      planned_start TEXT NOT NULL,
      planned_end TEXT,
      departure_at TEXT,
      returned_at TEXT,
      initial_km INTEGER,
      final_km INTEGER,
      fuel_level_out TEXT DEFAULT '',
      fuel_level_in TEXT DEFAULT '',
      departure_photo TEXT DEFAULT '',
      return_photo TEXT DEFAULT '',
      signature_path TEXT DEFAULT '',
      condition_out TEXT DEFAULT '',
      condition_in TEXT DEFAULT '',
      review_result TEXT DEFAULT '',
      review_notes TEXT DEFAULT '',
      income REAL NOT NULL DEFAULT 0,
      quoted_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      cancellation_reason TEXT DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS operation_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL REFERENCES operations(id),
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      receipt_path TEXT DEFAULT '',
      is_void INTEGER NOT NULL DEFAULT 0,
      void_reason TEXT DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS record_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      previous_data TEXT NOT NULL,
      corrected_data TEXT NOT NULL,
      corrected_by INTEGER NOT NULL REFERENCES users(id),
      corrected_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vehicle_plate ON vehicles(plate);
    CREATE INDEX IF NOT EXISTS idx_mileage_vehicle ON mileage_logs(vehicle_id, departure_at);
    CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle ON maintenance_records(vehicle_id, service_date);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_operations_vehicle ON operations(vehicle_id, status, planned_start);
    CREATE INDEX IF NOT EXISTS idx_operations_driver ON operations(driver_id, status, planned_start);
    CREATE INDEX IF NOT EXISTS idx_operation_expenses ON operation_expenses(operation_id, expense_date);
  `);

  migrateExistingDatabase();
}

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrateUsersRoleConstraint() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
  if (schema.includes("capturista") && schema.includes("auditor")) return;
  const passwordFlag = hasColumn("users", "must_change_password")
    ? "must_change_password"
    : "CASE WHEN username = 'admin' THEN 1 ELSE 0 END";
  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN;
    ALTER TABLE users RENAME TO users_legacy;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','gestor','taller','chofer','capturista','auditor')),
      phone TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users
      (id, name, username, email, password_hash, password_salt, role, phone, photo, active,
       must_change_password, created_at, updated_at)
    SELECT id, name, username, email, password_hash, password_salt, role, phone, photo, active,
      ${passwordFlag}, created_at, updated_at
    FROM users_legacy;
    DROP TABLE users_legacy;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateExistingDatabase() {
  migrateUsersRoleConstraint();
  addColumn("users", "must_change_password INTEGER NOT NULL DEFAULT 0");
  addColumn("vehicles", "operational_status TEXT NOT NULL DEFAULT 'disponible'");
  addColumn("vehicles", "allow_administrative INTEGER NOT NULL DEFAULT 1");
  addColumn("vehicles", "allow_internal INTEGER NOT NULL DEFAULT 1");
  addColumn("vehicles", "allow_tourism INTEGER NOT NULL DEFAULT 0");
  addColumn("vehicles", "allow_rental INTEGER NOT NULL DEFAULT 0");
  addColumn("vehicles", "block_reason TEXT DEFAULT ''");
  for (const table of [
    "mileage_logs", "maintenance_records", "tire_changes", "incidents",
    "custody_sheets", "fuel_vouchers", "documents"
  ]) {
    addColumn(table, "operation_id INTEGER REFERENCES operations(id)");
  }
  for (const table of [
    "mileage_logs", "maintenance_records", "tire_changes", "incidents",
    "custody_sheets", "fuel_vouchers"
  ]) {
    addColumn(table, "is_void INTEGER NOT NULL DEFAULT 0");
    addColumn(table, "void_reason TEXT DEFAULT ''");
  }
  addColumn("incidents", "severity TEXT NOT NULL DEFAULT 'media'");
  addColumn("incidents", "blocks_vehicle INTEGER NOT NULL DEFAULT 0");
}

function insertUser(name, username, email, password, role, phone = "", mustChangePassword = 0) {
  const { salt, hash } = hashPassword(password);
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO users
      (name, username, email, password_hash, password_salt, role, phone, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, username, email, hash, salt, role, phone, mustChangePassword, stamp, stamp);
}

export function seedDatabase() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  if (count > 0) return;

  const stamp = nowIso();
  db.exec("BEGIN");
  try {
    insertUser("Administrador General", "admin", "admin@empresa", "admin", "admin", "3781000000", 1);
    insertUser("Mariana López", "gestor", "gestor@empresa", "gestor123", "gestor", "3781112233");
    insertUser("Luis Hernández", "chofer", "chofer@empresa", "chofer123", "chofer", "3782223344");

    ["Automóvil", "Camioneta", "Camión", "Motocicleta"].forEach((name) =>
      db.prepare("INSERT INTO vehicle_types (name) VALUES (?)").run(name)
    );

    const vehicles = [
      ["JAL-482-A", 2, "Toyota", "Hilux", 2023, "8AJHA3CD7P1234567", "Blanco", "disponible", "GNP", "POL-90821", dateOffset(18), 48250, 10.8],
      ["TPA-109-B", 1, "Nissan", "Versa", 2022, "3N1CN8EV4NL123456", "Gris", "en_uso", "AXA", "POL-77410", dateOffset(82), 73410, 15.2],
      ["JAL-731-C", 3, "Ford", "F-350", 2021, "1FDRF3G67MEC12345", "Azul", "taller", "Qualitas", "POL-33018", dateOffset(-4), 119820, 6.9]
    ];
    const vehicleInsert = db.prepare(`
      INSERT INTO vehicles
      (plate, type_id, brand, model, year, vin, color, status, insurer, policy_number,
       insurance_expiry, current_mileage, average_consumption, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    vehicles.forEach((vehicle) => vehicleInsert.run(...vehicle, stamp, stamp));

    const driverInsert = db.prepare(`
      INSERT INTO drivers
      (user_id, name, phone, license_number, license_expiry, address, emergency_phone, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    driverInsert.run(3, "Luis Hernández", "523782223344", "JAL-LIC-5521", dateOffset(42), "Tepatitlán de Morelos, Jal.", "523781112233", "Operador de camioneta y automóvil", stamp, stamp);
    driverInsert.run(null, "Carlos Ramírez", "523783334455", "JAL-LIC-7308", dateOffset(12), "Arandas, Jal.", "523784445566", "Operador de carga", stamp, stamp);

    const workshopInsert = db.prepare(`
      INSERT INTO workshops (name, address, phone, contact, email, services, standard_rates, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    workshopInsert.run("Servicio Automotriz Los Altos", "Av. González Gallo 420, Tepatitlán", "3787821010", "Ing. Javier Pérez", "servicio@losaltos.mx", "Afinación, frenos, suspensión", "Servicio básico desde $1,850", stamp);
    workshopInsert.run("Llantas del Centro", "Morelos 115, Tepatitlán", "3787819080", "Ana Gómez", "ventas@llantascentro.mx", "Llantas, alineación y balanceo", "Alineación desde $650", stamp);

    const maintenanceInsert = db.prepare(`
      INSERT INTO maintenance_records
      (vehicle_id, service_type, description, workshop_id, service_date, cost, mileage,
       next_service_km, next_service_date, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    maintenanceInsert.run(1, "Servicio preventivo", "Cambio de aceite y filtros", 1, dateOffset(-35), 2450, 47000, 57000, dateOffset(120), "completada", 1, stamp, stamp);
    maintenanceInsert.run(3, "Frenos", "Cambio de balatas delanteras y revisión general", 1, dateOffset(1), 5800, 119820, 125000, dateOffset(75), "en_proceso", 1, stamp, stamp);

    db.prepare(`
      INSERT INTO mileage_logs
      (vehicle_id, driver_id, departure_at, arrival_at, initial_km, final_km, observations, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 1, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 43200000).toISOString(), 73120, 73410, "Comisión regional sin incidentes", 2, stamp);

    db.prepare(`
      INSERT INTO fuel_vouchers
      (vehicle_id, driver_id, voucher_date, liters, total_cost, mileage, supplier, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 1, dateOffset(-1), 36.5, 865.20, 73320, "Servicio Los Altos", "Carga para comisión", 2, stamp);

    db.prepare(`
      INSERT INTO incidents
      (vehicle_id, driver_id, incident_date, description, cost, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 2, dateOffset(-18), "Golpe menor en defensa durante maniobra de estacionamiento", 1200, "cerrado", 1, stamp);

    db.prepare(`
      INSERT INTO settings (id, company_name, company_phone, company_address, alert_days, alert_km, updated_at)
      VALUES (1, 'NovaFlota Gobierno', '3787888700', 'Tepatitlán de Morelos, Jalisco', 30, 1000, ?)
    `).run(stamp);

    const operation = db.prepare(`
      INSERT INTO operations
      (folio, operation_type, status, vehicle_id, driver_id, dependency_name, destination, purpose,
       planned_start, planned_end, initial_km, fuel_level_out, condition_out, created_by, created_at, updated_at)
      VALUES (?, 'comision', 'reservada', 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "OP-DEMO-0001",
      "Servicios Generales",
      "Guadalajara, Jalisco",
      "Traslado administrativo de documentación",
      new Date(Date.now() + 86400000).toISOString(),
      new Date(Date.now() + 129600000).toISOString(),
      48250,
      "3/4",
      "Sin daños visibles",
      stamp,
      stamp
    );
    audit(1, "create", "operation", Number(operation.lastInsertRowid), null, { folio: "OP-DEMO-0001", status: "reservada" });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(userId, action, entityType, entityId, before = null, after = null) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, before_data, after_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    action,
    entityType,
    entityId || null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    nowIso()
  );
}

export function recomputeVehicleStatus(vehicleId) {
  const vehicle = db.prepare("SELECT id, status, block_reason FROM vehicles WHERE id = ?").get(vehicleId);
  if (!vehicle) return null;
  let operationalStatus = "disponible";
  if (vehicle.status === "inactivo") {
    operationalStatus = "inactivo";
  } else {
    const blockingIncident = db.prepare(`
      SELECT id FROM incidents
      WHERE vehicle_id = ? AND is_void = 0 AND blocks_vehicle = 1 AND status != 'cerrado'
      LIMIT 1
    `).get(vehicleId);
    const maintenance = db.prepare(`
      SELECT id FROM maintenance_records
      WHERE vehicle_id = ? AND is_void = 0 AND status IN ('abierta','en_proceso')
      LIMIT 1
    `).get(vehicleId);
    const operation = db.prepare(`
      SELECT status FROM operations
      WHERE vehicle_id = ? AND status IN ('reservada','activa','pendiente_revision')
      ORDER BY CASE status WHEN 'activa' THEN 1 WHEN 'pendiente_revision' THEN 2 ELSE 3 END, planned_start
      LIMIT 1
    `).get(vehicleId);
    const legacyCustody = db.prepare(`
      SELECT id FROM custody_sheets
      WHERE vehicle_id = ? AND returned_at IS NULL AND is_void = 0 AND operation_id IS NULL
      LIMIT 1
    `).get(vehicleId);
    if (blockingIncident || vehicle.block_reason) operationalStatus = "fuera_servicio";
    else if (maintenance) operationalStatus = "taller";
    else if (operation?.status === "activa") operationalStatus = "en_uso";
    else if (operation?.status === "pendiente_revision") operationalStatus = "pendiente_revision";
    else if (operation?.status === "reservada") operationalStatus = "reservado";
    else if (legacyCustody) operationalStatus = "en_uso";
  }
  const legacyStatus = {
    disponible: "disponible",
    reservado: "en_uso",
    en_uso: "en_uso",
    pendiente_revision: "en_uso",
    taller: "taller",
    fuera_servicio: "taller",
    inactivo: "inactivo"
  }[operationalStatus];
  db.prepare(`
    UPDATE vehicles SET operational_status = ?, status = ?, updated_at = ? WHERE id = ?
  `).run(operationalStatus, legacyStatus, nowIso(), vehicleId);
  return operationalStatus;
}

export function recomputeAllVehicleStatuses() {
  db.prepare("SELECT id FROM vehicles").all().forEach((vehicle) => recomputeVehicleStatus(vehicle.id));
}

export function refreshAlerts() {
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() || { alert_days: 30 };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + settings.alert_days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const upsert = db.prepare(`
    INSERT INTO alerts (alert_key, type, entity_type, entity_id, message, due_date, due_km, severity, resolved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      message = excluded.message,
      due_date = excluded.due_date,
      due_km = excluded.due_km,
      severity = excluded.severity,
      resolved = 0
  `);

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE alerts SET resolved = 1").run();

    const insurance = db.prepare(`
      SELECT id, plate, insurance_expiry FROM vehicles
      WHERE status != 'inactivo' AND insurance_expiry IS NOT NULL AND insurance_expiry <= ?
    `).all(cutoffDate);
    insurance.forEach((item) => upsert.run(
      `insurance-${item.id}`,
      "seguro",
      "vehicle",
      item.id,
      `Seguro de ${item.plate} ${item.insurance_expiry < today ? "vencido" : "próximo a vencer"}`,
      item.insurance_expiry,
      null,
      item.insurance_expiry < today ? "alta" : "media",
      nowIso()
    ));

    const licenses = db.prepare(`
      SELECT id, name, license_expiry FROM drivers
      WHERE active = 1 AND license_expiry IS NOT NULL AND license_expiry <= ?
    `).all(cutoffDate);
    licenses.forEach((item) => upsert.run(
      `license-${item.id}`,
      "licencia",
      "driver",
      item.id,
      `Licencia de ${item.name} próxima a vencer`,
      item.license_expiry,
      null,
      item.license_expiry < today ? "alta" : "media",
      nowIso()
    ));

    const services = db.prepare(`
      SELECT m.id, m.vehicle_id, v.plate, m.next_service_date, m.next_service_km, v.current_mileage
      FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
      WHERE m.status = 'completada'
        AND ((m.next_service_date IS NOT NULL AND m.next_service_date <= ?)
          OR (m.next_service_km IS NOT NULL AND m.next_service_km - v.current_mileage <= ?))
    `).all(cutoffDate, settings.alert_km);
    services.forEach((item) => upsert.run(
      `maintenance-${item.id}`,
      "mantenimiento",
      "vehicle",
      item.vehicle_id,
      `Servicio próximo para ${item.plate}`,
      item.next_service_date,
      item.next_service_km,
      (item.next_service_km && item.next_service_km <= item.current_mileage) ? "alta" : "media",
      nowIso()
    ));

    const overdueOperations = db.prepare(`
      SELECT o.id, o.folio, o.planned_end, o.status, v.plate
      FROM operations o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.status IN ('reservada','activa','pendiente_revision')
        AND o.planned_end IS NOT NULL AND date(o.planned_end) < date('now')
    `).all();
    overdueOperations.forEach((item) => upsert.run(
      `operation-overdue-${item.id}`,
      "retorno",
      "operation",
      item.id,
      `${item.folio} de ${item.plate} tiene retorno o revisión pendiente`,
      String(item.planned_end).slice(0, 10),
      null,
      "alta",
      nowIso()
    ));

    const blockingIncidents = db.prepare(`
      SELECT i.id, i.vehicle_id, v.plate
      FROM incidents i JOIN vehicles v ON v.id = i.vehicle_id
      WHERE i.is_void = 0 AND i.blocks_vehicle = 1 AND i.status != 'cerrado'
    `).all();
    blockingIncidents.forEach((item) => upsert.run(
      `blocking-incident-${item.id}`,
      "incidente",
      "vehicle",
      item.vehicle_id,
      `${item.plate} está bloqueado por un incidente pendiente`,
      null,
      null,
      "alta",
      nowIso()
    ));

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

initializeDatabase();
seedDatabase();
recomputeAllVehicleStatuses();
refreshAlerts();
