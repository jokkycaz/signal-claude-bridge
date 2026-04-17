$log = "C:/users/jokky/documents/claude-signal-bridge/setup-task.log"
$bat = "C:\users\jokky\documents\claude-signal-bridge\maintenance.bat"

"Starting task setup at $(Get-Date)" | Out-File $log -Encoding utf8
schtasks /create /tn "ChadBridgeMaintenance_5AM" /tr $bat /sc daily /st 05:00 /f 2>&1 | Out-File $log -Append -Encoding utf8
schtasks /create /tn "ChadBridgeMaintenance_5PM" /tr $bat /sc daily /st 17:00 /f 2>&1 | Out-File $log -Append -Encoding utf8
schtasks /query /tn "ChadBridgeMaintenance_5AM" 2>&1 | Out-File $log -Append -Encoding utf8
schtasks /query /tn "ChadBridgeMaintenance_5PM" 2>&1 | Out-File $log -Append -Encoding utf8
