# Control de Flotilla Integral · versión 1.1

Sistema web responsive para controlar una flotilla desde un solo flujo operativo. Vehículos, choferes, kilometraje, combustible, resguardos, incidentes, talleres, documentos, costos, alertas y reportes quedan relacionados mediante un folio de operación.

## Inicio fácil en Windows

1. Descomprime completamente el ZIP.
2. Abre la carpeta `fleet-control-mvp`.
3. Da doble clic en `INICIAR-SISTEMA.bat`.
4. La primera vez se instalará Node.js LTS si hace falta y se preparará la aplicación.
5. El navegador se abrirá automáticamente en `http://localhost:3000`.

No necesitas Docker ni escribir comandos. Mantén abierta la ventana negra mientras utilices el sistema.

Cuenta inicial:

- Usuario: `admin`
- Contraseña: `admin`

Al entrar por primera vez, el sistema solicita reemplazar la contraseña inicial.

## Qué cambió en la versión integral

- Operación central con folio único.
- Estados del vehículo calculados automáticamente.
- Reserva y validación de disponibilidad.
- Salida con kilometraje, combustible, condición y fotografía.
- Creación automática de bitácora y resguardo.
- Retorno único que cierra bitácora y resguardo.
- Revisión posterior antes de liberar la unidad.
- Bloqueo automático por incidentes graves o mantenimiento.
- Correcciones con motivo, valor anterior, valor nuevo, usuario y fecha.
- Kilometraje protegido contra edición directa.
- Modalidades habilitadas por vehículo.
- Costos, ingresos y resultado ligados a cada operación.
- Línea de tiempo integral por vehículo.
- Dashboard de tareas pendientes.
- Reportes de operación, rentabilidad y costo por kilómetro.
- Nuevos roles de Capturista y Consulta/Auditoría.
- Respaldo ZIP con base, fotografías, documentos, firmas y comprobantes.

## Flujo principal

1. Crea una operación y selecciona el tipo de servicio.
2. Asigna una unidad disponible y un chofer, responsable o cliente.
3. El sistema genera el folio y reserva el vehículo.
4. Registra la salida con kilometraje, combustible y condición.
5. Captura combustible, gastos o incidentes durante el servicio.
6. Registra el retorno desde una sola pantalla.
7. Revisa la unidad y libérala o envíala a mantenimiento.
8. Descarga la cuenta PDF o genera reportes del periodo.

Regla del sistema:

> Toda salida comienza con una operación, todo movimiento pertenece a esa operación y todo retorno la cierra completamente.

## Tipos de operación

- Comisión.
- Uso interno.
- Transporte turístico.
- Renta.
- Resguardo.
- Traslado a taller.

Cada unidad puede habilitarse para uso administrativo, interno, turístico, renta o varias modalidades.

## Estados automáticos

- Disponible.
- Reservado.
- En uso.
- Pendiente de revisión.
- En taller.
- Fuera de servicio.
- Inactivo.

El usuario no cambia libremente el estado. El sistema lo calcula con base en operaciones, mantenimientos, incidentes y bloqueos.

## Validaciones principales

- Impide dos operaciones abiertas para el mismo vehículo.
- Impide asignar un chofer ocupado.
- Impide asignar una licencia vencida.
- Impide utilizar una modalidad no habilitada.
- Impide iniciar con kilometraje menor al último registro.
- Impide retornar con kilometraje menor al inicial.
- Impide una fecha de retorno anterior a la salida.
- Impide liberar una unidad con incidente bloqueante.
- Impide desactivar un vehículo con una operación abierta.
- Conserva los movimientos importantes; se corrigen o anulan con motivo.

## Roles

| Rol | Alcance |
|---|---|
| Administrador | Acceso completo, usuarios, ajustes, correcciones y respaldos |
| Gestor | Operación completa y revisión, sin cambios críticos de seguridad |
| Capturista | Altas y capturas operativas, sin eliminación ni configuración delicada |
| Chofer | Sus unidades y operaciones asignadas, salidas, retornos y capturas |
| Taller | Mantenimientos y traslados relacionados |
| Consulta/Auditoría | Solo lectura, reportes y bitácora |

Cuentas de demostración adicionales:

| Usuario | Contraseña | Perfil |
|---|---|---|
| `gestor` | `gestor123` | Gestor |
| `chofer` | `chofer123` | Chofer |

## Ficha 360° del vehículo

La ficha muestra:

- Estado actual.
- Operación activa.
- Responsable.
- Kilometraje protegido.
- Seguro y vencimiento.
- Modalidades permitidas.
- Operaciones.
- Bitácora.
- Mantenimientos.
- Documentos.
- Combustible.
- Incidentes.
- Llantas.
- Resguardos.
- Línea de tiempo combinada.

## Reportes

Los reportes se descargan en CSV o PDF:

- Expediente integral de operaciones.
- Rentabilidad y costo por vehículo.
- Costo por kilómetro.
- Kilometraje por chofer.
- Combustible por periodo.
- Costos y mantenimientos.

Cada operación también genera una cuenta individual en PDF.

## Respaldos

Desde Configuración, el administrador puede descargar:

- Respaldo completo ZIP: base SQLite, fotografías, documentos, firmas y comprobantes.
- Respaldo de datos JSON: utilizable para restaurar los registros desde la interfaz.

Guarda el ZIP completo en una ubicación externa con la periodicidad definida por la institución.

## Inicio alternativo

Con Node.js 22.12 o posterior:

```bash
npm install
npm start
```

Con Docker:

```bash
docker compose up --build
```

Después abre `http://localhost:3000`.

## Pruebas

```bash
npm run check
npm test
```

Las pruebas verifican acceso, dashboard, vehículos, kilometraje protegido, ajustes auditados, operación central, salida, retorno, estados automáticos, resguardos, PDF, CSV y rechazo de credenciales inválidas.

## Datos y archivos

- Base local: `data/flotilla.sqlite`.
- Fotografías y documentos: `uploads/`.
- Puerto predeterminado: `3000`.

La aplicación migra automáticamente una base anterior del MVP al nuevo esquema. Antes de actualizar una instalación en uso, conserva también una copia externa de las carpetas `data` y `uploads`.

## Seguridad aplicada

- Contraseñas con `scrypt` y salt individual.
- Sesiones firmadas con vencimiento.
- Cambio de contraseña inicial.
- Permisos validados en el servidor.
- Consultas SQLite parametrizadas.
- Archivos limitados a tipos y tamaño permitidos.
- Auditoría de accesos, altas, correcciones, cancelaciones, retornos y exportaciones.
- Desactivación en lugar de eliminación del historial.

## Alcance de esta versión

La versión 1.1 está preparada para piloto local o de una sola instancia. Para operar desde varias computadoras y teléfonos a escala institucional, la siguiente etapa recomendada es PostgreSQL, almacenamiento seguro de archivos, PWA instalable, notificaciones automáticas y despliegue central.
