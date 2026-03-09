@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "SCRIPT_DIR=%cd%"
set "DEFAULT_VENV_DIR=S:\obsidian-chinese-checker\.venv"
set "RAW_VENV_INPUT=%~1"
set "VENV_DIR="
set "VENV_PY="
set "BASE_PY="
set "BASE_VER="
set "PYTHON_EXE="
set "VERIFY_LOG=%TEMP%\csc_pycorrector_verify.log"

echo.
echo =====================================
echo Obsidian Chinese Checker - Installer
echo =====================================
echo.

echo [STEP] Choose virtual environment directory (.venv)
echo [INFO] Default: "%DEFAULT_VENV_DIR%"
if not defined RAW_VENV_INPUT (
  set /p RAW_VENV_INPUT=Venv path (press Enter for default): 
)
if not defined RAW_VENV_INPUT set "RAW_VENV_INPUT=%DEFAULT_VENV_DIR%"
set "RAW_VENV_INPUT=%RAW_VENV_INPUT:"=%"
for %%I in ("%RAW_VENV_INPUT%") do set "VENV_DIR=%%~fI"
if not defined VENV_DIR (
  echo [ERROR] Invalid venv path.
  goto fail
)
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

echo [INFO] Selected venv directory: "%VENV_DIR%"
echo.

if exist "%VENV_PY%" (
  set "PYTHON_EXE=%VENV_PY%"
  echo [INFO] Existing virtual environment found.
  goto install_packages
)

echo [STEP] Looking for Python 3...
where py >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('py -3.11 -c "import sys;print(sys.executable)" 2^>nul') do (
    if not defined BASE_PY set "BASE_PY=%%I"
  )
  for /f "delims=" %%I in ('py -3.10 -c "import sys;print(sys.executable)" 2^>nul') do (
    if not defined BASE_PY set "BASE_PY=%%I"
  )
  for /f "delims=" %%I in ('py -3.12 -c "import sys;print(sys.executable)" 2^>nul') do (
    if not defined BASE_PY set "BASE_PY=%%I"
  )
  for /f "delims=" %%I in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do (
    if not defined BASE_PY set "BASE_PY=%%I"
  )
)

if not defined BASE_PY (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%I in ('python -c "import sys;print(sys.executable)" 2^>nul') do (
      if not defined BASE_PY set "BASE_PY=%%I"
    )
  )
)

if not defined BASE_PY (
  echo [ERROR] Python 3 was not found.
  echo Please install Python 3 and run this script again.
  goto fail
)

echo [INFO] Base Python: "%BASE_PY%"
for /f "delims=" %%I in ('"%BASE_PY%" -c "import sys;print(f""{sys.version_info.major}.{sys.version_info.minor}"")" 2^>nul') do (
  set "BASE_VER=%%I"
)
if defined BASE_VER (
  echo [INFO] Base Python version: %BASE_VER%
  if "%BASE_VER%"=="3.13" (
    echo [WARN] Python 3.13 may have limited torch wheel support.
    echo [WARN] If torch install fails, install Python 3.11 and rerun this script.
  )
)

echo [STEP] Creating venv at "%VENV_DIR%" ...
"%BASE_PY%" -m venv "%VENV_DIR%"
if errorlevel 1 (
  echo [ERROR] Failed to create virtual environment.
  echo [HINT] Ensure target drive/path exists and is writable.
  goto fail
)

if not exist "%VENV_PY%" (
  echo [ERROR] venv python not found: "%VENV_PY%"
  goto fail
)

set "PYTHON_EXE=%VENV_PY%"

:install_packages
echo [STEP] Upgrading pip/setuptools/wheel...
"%PYTHON_EXE%" -m pip install --upgrade pip setuptools wheel

echo [STEP] Installing pycorrector...
"%PYTHON_EXE%" -m pip install --upgrade pycorrector
if errorlevel 1 (
  echo [WARN] Default index failed. Retrying with Tsinghua mirror...
  "%PYTHON_EXE%" -m pip install --upgrade pycorrector -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 (
    echo [ERROR] Failed to install pycorrector.
    goto fail
  )
)

echo [STEP] Verifying pycorrector...
call :verify_pycorrector
if errorlevel 1 (
  findstr /c:"No module named 'torch'" "%VERIFY_LOG%" >nul 2>nul
  if not errorlevel 1 (
    echo [WARN] pycorrector requires torch. Installing torch...
    call :install_torch
    if errorlevel 1 (
      echo [ERROR] Failed to install torch.
      goto fail_with_log
    )
    echo [STEP] Re-verifying pycorrector...
    call :verify_pycorrector
    if errorlevel 1 goto fail_with_log
  ) else (
    goto fail_with_log
  )
)

echo.
echo [DONE] pycorrector installed successfully.
echo.
echo Plugin settings (Python local engine):
echo   Python venv directory : "%VENV_DIR%"
echo   Python executable     : "%PYTHON_EXE%"
echo   Python script path    : "%SCRIPT_DIR%\python_engine_service.py"
echo   Python engine switch  : enable it in plugin settings if currently disabled
echo.
echo Reuse this command later:
echo   "%SCRIPT_DIR%\install_pycorrector.bat" "%VENV_DIR%"
echo.
pause
exit /b 0

:verify_pycorrector
"%PYTHON_EXE%" -c "import pycorrector,sys;print(pycorrector.__version__)" >"%VERIFY_LOG%" 2>&1
if errorlevel 1 exit /b 1
type "%VERIFY_LOG%"
exit /b 0

:install_torch
"%PYTHON_EXE%" -m pip install --upgrade torch --index-url https://download.pytorch.org/whl/cpu
if not errorlevel 1 exit /b 0
echo [WARN] PyTorch CPU index failed. Retrying with Tsinghua mirror...
"%PYTHON_EXE%" -m pip install --upgrade torch -i https://pypi.tuna.tsinghua.edu.cn/simple
if not errorlevel 1 exit /b 0
echo [WARN] Tsinghua mirror failed. Retrying with default index...
"%PYTHON_EXE%" -m pip install --upgrade torch
if not errorlevel 1 exit /b 0
exit /b 1

:fail_with_log
echo [ERROR] pycorrector verification failed. Details:
if exist "%VERIFY_LOG%" type "%VERIFY_LOG%"
goto fail

:fail
echo.
echo Install failed. Please review logs and retry.
echo.
pause
exit /b 1
