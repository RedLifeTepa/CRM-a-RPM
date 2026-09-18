@echo off
setlocal
cd /d "%~dp0"
title Control de Flotilla - Inicio facil
color 0B

echo.
echo ============================================================
echo             CONTROL DE FLOTILLA - INICIO FACIL
echo ============================================================
echo.

rem Si el sistema ya esta encendido, solamente abre el navegador.
powershell -NoProfile -Command "try { Invoke-WebRequest 'http://localhost:3000/api/health' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo El sistema ya esta encendido. Abriendo el navegador...
  start "" "http://localhost:3000"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

rem Comprueba si Node.js esta disponible.
where node.exe >nul 2>nul
if errorlevel 1 goto instalar_node

for /f "delims=" %%V in ('node.exe -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto instalar_node
if %NODE_MAJOR% LSS 22 goto actualizar_node
goto preparar

:instalar_node
echo Es la primera vez que se inicia el sistema.
echo Se instalara automaticamente el componente necesario: Node.js LTS.
echo.
where winget.exe >nul 2>nul
if errorlevel 1 goto instalacion_manual
winget.exe install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto instalacion_manual
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node.exe >nul 2>nul
if errorlevel 1 goto reiniciar_despues_de_instalar
goto preparar

:actualizar_node
echo La version de Node.js instalada es antigua.
echo Se actualizara automaticamente a la version LTS.
echo.
where winget.exe >nul 2>nul
if errorlevel 1 goto instalacion_manual
winget.exe upgrade --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto instalacion_manual
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto preparar

:preparar
where npm.cmd >nul 2>nul
if errorlevel 1 goto reiniciar_despues_de_instalar

if not exist "node_modules\express\package.json" goto instalar_dependencias
if not exist "node_modules\archiver\package.json" goto instalar_dependencias
goto iniciar

:instalar_dependencias
  echo.
  echo Preparando la aplicacion. Esto solo tarda la primera vez...
  echo.
  call npm.cmd install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto error_dependencias

:iniciar

echo.
echo Sistema integral listo.
echo.
echo Usuario:    admin
echo Contrasena: admin
echo.
echo El navegador se abrira automaticamente.
echo No cierres esta ventana mientras estes usando el sistema.
echo Para apagarlo, cierra esta ventana o presiona Ctrl+C.
echo.

start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'" >nul 2>nul
call npm.cmd start
goto fin

:reiniciar_despues_de_instalar
echo.
echo Node.js se instalo correctamente.
echo Cierra esta ventana y vuelve a dar doble clic en INICIAR-SISTEMA.bat.
echo.
pause
exit /b 0

:instalacion_manual
echo.
echo No fue posible instalar Node.js automaticamente.
echo Se abrira la pagina oficial. Instala la version LTS y despues
echo vuelve a dar doble clic en INICIAR-SISTEMA.bat.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:error_dependencias
echo.
echo No fue posible preparar la aplicacion.
echo Comprueba tu conexion a Internet y vuelve a intentarlo.
echo.
pause
exit /b 1

:fin
endlocal
