@echo off
rem typetorch for cmd.exe and PowerShell: runs this checkout of the CLI with Bun. Add this folder to PATH.
bun "%~dp0..\src\index.ts" %*
