@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "FILE=github-turbo.js"
set "NAME=github-turbo.user.js"
set "DIR=.serve"
set "URL=http://127.0.0.1:%PORT%/%DIR%/%NAME%"

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 python，请先安装 Python 3 并勾选 "Add Python to PATH"。
  pause
  exit /b 1
)

if not exist "%FILE%" (
  echo [错误] 未找到 %FILE%，请确认脚本就在本目录下。
  pause
  exit /b 1
)

rem 脚本管理器只在地址以 .user.js 结尾时才弹安装页，
rem 所以这里复制一份别名文件，真正的源码仍然只有 %FILE% 一份。
if not exist "%DIR%" mkdir "%DIR%"
copy /y "%FILE%" "%DIR%\%NAME%" >nul
if errorlevel 1 (
  echo [错误] 无法生成 %DIR%\%NAME%，请检查目录权限。
  pause
  exit /b 1
)

echo ==========================================================
echo   GitHub Turbo 本地安装服务
echo   地址: %URL%
echo   服务在最小化窗口中运行，关闭该窗口即停止服务。
echo ==========================================================
echo.

start "" /min cmd /c "python -m http.server %PORT% --bind 127.0.0.1"
timeout /t 2 >nul

echo 正在打开浏览器...
start "" "%URL%"

echo.
echo 应该会弹出脚本管理器的安装页；如果只是显示源码，请全选复制后
echo 粘贴到脚本管理器里新建脚本，效果相同。
echo 如果提示无法访问：确认 %PORT% 端口没有被占用，或先关闭系统代理。
echo.
timeout /t 5 >nul
endlocal
