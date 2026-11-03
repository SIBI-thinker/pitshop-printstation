param([Parameter(Mandatory=$true)][string]$Ssid, [Parameter(Mandatory=$true)][string]$Password)
# Starts Windows Mobile Hotspot with this name and password. Run with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
} | Select-Object -First 1
function Await($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function AwaitAction($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

[void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
[void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]

# The hotspot has to hang off a connection. Prefer the internet one; an offline laptop falls back to any other.
$profiles = @([Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()) +
  @([Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()) | Where-Object { $_ }
$manager = $null
foreach ($connection in $profiles) {
  try { $manager = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($connection); break } catch {}
}
if (-not $manager) { throw 'No network connection can host the hotspot. Turn on Mobile Hotspot in Settings once to set it up.' }

$config = $manager.GetCurrentAccessPointConfiguration()
if ($config.Ssid -ne $Ssid -or $config.Passphrase -ne $Password) {
  $config.Ssid = $Ssid
  $config.Passphrase = $Password
  AwaitAction ($manager.ConfigureAccessPointAsync($config))
}

if ($manager.TetheringOperationalState -eq 'On') {
  Write-Output "Hotspot already on: $Ssid"
  exit 0
}
$result = Await ($manager.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
if ($result.Status -ne 'Success') { throw "Hotspot failed to start: $($result.Status) $($result.AdditionalErrorMessage)" }
Write-Output "Hotspot started: $Ssid"
