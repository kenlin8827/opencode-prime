# install/scripts/tools/luvus-pre-upgrade.win32-x64.ps1
# Pre-upgrade hook for luvus on Windows (referenced from install/tools.jsonc
# as "@script:luvus-pre-upgrade"; see the luvus update_check comment there).
# A running luvus.exe locks its own image, so the installer cannot replace
# the binary while the background server that `ocp tui` keeps alive is
# running. Stop the server (kills all panes) and wait for every luvus
# process to exit before the upgrade step runs.
# Best-effort by design: if a luvus process survives the ~12s wait, the
# upgrade step's copy fails loudly and the user sees the real problem.

luvus server stop
$n = 0
while ((Get-Process luvus -ErrorAction SilentlyContinue) -and ($n++ -lt 24)) {
  Start-Sleep -Milliseconds 500
}
