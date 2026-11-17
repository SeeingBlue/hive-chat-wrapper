@ECHO off
REM hive-chat-wrapper.cmd: Windows launcher for the Hive Chat reference wrapper.
REM Runs the launcher beside this file with Node.js from PATH (22.18 or newer),
REM passing every argument through unchanged. It is the same as running
REM   node bin\hive-chat-wrapper COMMAND ...
REM from the package folder. Exit status and Ctrl-C behave as with node itself.
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
WHERE node >NUL 2>NUL
IF ERRORLEVEL 1 (
  ECHO hive-chat-wrapper: Node.js was not found on PATH. Install Node.js 22.18 or newer from https://nodejs.org 1>&2
  EXIT /b 1
)
REM Same tail as npm's own shims: no "Terminate batch job (Y/N)?" after Ctrl-C.
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%hive-chat-wrapper" %*
