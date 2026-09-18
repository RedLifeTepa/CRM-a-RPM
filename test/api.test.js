import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

const testDb = path.resolve(`data/test-${process.pid}.sqlite`);
process.env.FLEET_DB_PATH = testDb;
process.env.UPLOAD_DIR = path.resolve(`uploads/test-${process.pid}`);
process.env.JWT_SECRET = "test-secret";

const { app } = await import("../src/server.js");
const { db } = await import("../src/database.js");

let server;
let baseUrl;
let adminToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(`${testDb}${suffix}`, { force: true });
  }
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body === "string") headers.set("content-type", "application/json");
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  return { response, body };
}

test("health endpoint is available", async () => {
  const { response, body } = await request("/api/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
});

test("initial admin can sign in", async () => {
  const { response, body } = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "admin", password: "admin" })
  });
  assert.equal(response.status, 200);
  assert.equal(body.user.role, "admin");
  assert.ok(body.token);
  adminToken = body.token;
});

test("dashboard exposes seeded operational metrics", async () => {
  const { response, body } = await request("/api/dashboard");
  assert.equal(response.status, 200);
  assert.equal(body.metrics.totalVehicles, 3);
  assert.ok(body.metrics.activeAlerts >= 1);
  assert.ok(Array.isArray(body.activity));
});

test("vehicle lifecycle works and is audited", async () => {
  const created = await request("/api/vehicles", {
    method: "POST",
    body: JSON.stringify({
      plate: "TEST-001",
      brand: "Unidad",
      model: "Prueba",
      year: 2026,
      currentMileage: 125,
      status: "disponible"
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.plate, "TEST-001");

  const updated = await request(`/api/vehicles/${created.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ currentMileage: 9999, color: "Negro" })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.currentMileage, 125, "el kilometraje no se edita desde la ficha");

  const adjusted = await request(`/api/vehicles/${created.body.id}/mileage-adjustment`, {
    method: "POST",
    body: JSON.stringify({ newMileage: 250, reason: "Corrección de captura inicial" })
  });
  assert.equal(adjusted.response.status, 200);
  assert.equal(adjusted.body.currentMileage, 250);

  const detail = await request(`/api/vehicles/${created.body.id}`);
  assert.equal(detail.response.status, 200);
  assert.ok(Array.isArray(detail.body.maintenance));
  assert.ok(Array.isArray(detail.body.documents));

  const logs = await request("/api/audit");
  assert.equal(logs.response.status, 200);
  assert.ok(logs.body.some((entry) => entry.entityType === "vehicle" && entry.action === "create"));
});

test("central operation connects reservation, departure, return and automatic status", async () => {
  const vehicle = await request("/api/vehicles", {
    method: "POST",
    body: JSON.stringify({
      plate: "OPS-101",
      brand: "Unidad",
      model: "Integral",
      currentMileage: 1000,
      allowAdministrative: true
    })
  });
  assert.equal(vehicle.response.status, 201);

  const operation = await request("/api/operations", {
    method: "POST",
    body: JSON.stringify({
      operationType: "comision",
      vehicleId: vehicle.body.id,
      driverId: 1,
      purpose: "Prueba integral de comisión",
      destination: "Guadalajara",
      plannedStart: "2026-07-28T09:00:00",
      plannedEnd: "2026-07-28T18:00:00"
    })
  });
  assert.equal(operation.response.status, 201);
  assert.match(operation.body.folio, /^OP-2026-/);

  const start = await request(`/api/operations/${operation.body.id}/start`, {
    method: "POST",
    body: JSON.stringify({
      departureAt: "2026-07-28T09:05:00",
      initialKm: 1000,
      fuelLevelOut: "lleno",
      conditionOut: "Unidad revisada"
    })
  });
  assert.equal(start.response.status, 200);
  assert.equal(start.body.status, "activa");

  const returned = await request(`/api/operations/${operation.body.id}/return`, {
    method: "POST",
    body: JSON.stringify({
      returnedAt: "2026-07-28T17:30:00",
      finalKm: 1120,
      fuelLevelIn: "1/2",
      conditionIn: "Sin daños",
      releaseNow: true
    })
  });
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.status, "cerrada");
  assert.equal(returned.body.finalKm, 1120);

  const detail = await request(`/api/vehicles/${vehicle.body.id}`);
  assert.equal(detail.body.status, "disponible");
  assert.equal(detail.body.currentMileage, 1120);
  assert.equal(detail.body.operations[0].folio, operation.body.folio);
  assert.ok(detail.body.custodySheets[0].returnedAt);
});

test("custody, tires and exports produce usable records", async () => {
  const tire = await request("/api/tire-changes", {
    method: "POST",
    body: JSON.stringify({
      vehicleId: 1,
      changeDate: "2026-07-28",
      tireType: "265/65 R17",
      position: "Juego completo",
      cost: 9200,
      mileage: 48250
    })
  });
  assert.equal(tire.response.status, 201);

  const custody = await request("/api/custody-sheets", {
    method: "POST",
    body: JSON.stringify({
      vehicleId: 1,
      driverId: 1,
      deliveredAt: "2026-07-28T09:00:00",
      deliveryKm: 48250,
      observations: "Unidad entregada con tanque lleno"
    })
  });
  assert.equal(custody.response.status, 201);

  const pdf = await fetch(`${baseUrl}/api/custody-sheets/${custody.body.id}/pdf`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /application\/pdf/);
  assert.ok((await pdf.arrayBuffer()).byteLength > 500);

  const csv = await fetch(`${baseUrl}/api/reports?type=maintenance&format=csv`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /placa/i);
});

test("full backup includes database and uploaded-file container", async () => {
  const backup = await fetch(`${baseUrl}/api/backup/full`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get("content-type"), /application\/zip/);
  const bytes = new Uint8Array(await backup.arrayBuffer());
  assert.ok(bytes.byteLength > 500);
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
});

test("invalid credentials are rejected", async () => {
  const { response } = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "admin", password: "incorrecta" }),
    headers: { authorization: "" }
  });
  assert.equal(response.status, 401);
});
