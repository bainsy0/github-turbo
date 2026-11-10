@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8765"
set "FILE=github-turbo.js"
set "NAME=github-turbo.user.js"
set "DIR=.serve"
set "URL=http://127.0.0.1:%PORT%/%DIR%/%NAME%"

rem ---- 找一个能用的 Python 3：优先 python，其次 py -3 ----
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo [错误] 未找到 python / py，请安装 Python 3 并勾选 "Add Python to PATH"。
  pause
  exit /b 1
)

rem where 可能命中的是 Microsoft Store 的占位别名（一执行就跳商店），
rem 必须实跑一次确认解释器真的可用，否则服务会在最小化窗口里静默失败。
%PY% -c "import sys" >nul 2>nul
if errorlevel 1 (
  echo [错误] %PY% 无法执行，可能是 Microsoft Store 的占位别名。
  echo        请安装真正的 Python 3，并确认命令行里 python -c "import sys" 能跑通。
  pause
  exit /b 1
)

if not exist "%FILE%" (
  echo [错误] 未找到 %FILE%，请确认脚本就在本目录下。
  pause
  exit /b 1
)

rem 端口被占用时 http.server 会直接退出，浏览器只能打开一个空地址，先查一次
netstat -ano | findstr /c:":%PORT%" | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [错误] 端口 %PORT% 已被占用，请先关掉占用它的程序，或修改本文件里的 PORT。
  pause
  exit /b 1
)

rem 脚本管理器只在地址以 .user.js 结尾时才弹安装页，
rem 所以这里复制一份别名文件，真正的源码仍然只有 %FILE% 一份。
rem 改完 %FILE% 后要重新运行本文件，否则浏览器拿到的还是上次的副本。
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

start "" /min cmd /c "%PY% -m http.server %PORT% --bind 127.0.0.1"
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
