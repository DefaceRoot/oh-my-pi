<objective>
Perform an exhaustive line-by-line verification of the current Windows system state against the 
Wireless Mode specification document to identify any discrepancies that may indicate bugs in the 
Dragonglass application.

This is a VERIFICATION AND ANALYSIS task, not an implementation task. Your goal is to TEST and 
REPORT, then update the test script to be comprehensive.
</objective>

<context>
The user is currently in **Wireless mode** on the latest version of Dragonglass. They need to verify
that ALL documented system changes are correctly applied.

**Reference Documents:**
- `docs/Wireless-Expectation.md` - The authoritative specification (793 lines, 13 categories, 210+ changes)
- `scripts/Test-WirelessMode.ps1` - Existing verification script (1681 lines)

**Categories to Verify (from spec):**
1. Registry Changes (Sections A-N: ~90+ HKLM keys, ~8+ HKCU keys)
2. Network Adapter Changes
3. Service Changes  
4. Firewall Rules
5. DNS Configuration
6. Hosts File Modifications (50+ hostname entries)
7. Scheduled Tasks (8 tasks)
8. File System Changes
9. Wi-Fi Specific Changes
10. Power Settings
11. Windows Widgets & Weather App Blocking (3 methods, OR logic)
12. Bluetooth Handling
13. System Restore Integration
</context>

<requirements>
<requirement priority="critical">
Execute comprehensive system verification using PowerShell commands. For EVERY item in 
Wireless-Expectation.md, run the corresponding verification command and record whether the 
actual system state matches the expected state. Do NOT skip any items.
</requirement>

<requirement priority="critical">
The verification MUST cover ALL 13 categories completely. Each registry key, service state, 
firewall rule, hosts entry, scheduled task, etc. documented in the specification must be 
individually verified with actual PowerShell commands.
</requirement>

<requirement priority="critical">
Update `scripts/Test-WirelessMode.ps1` to include any tests that are currently missing. 
The script must be capable of verifying 100% of the documented Wireless mode changes. 
Compare the current script coverage against the specification and add any missing tests.
</requirement>

<requirement priority="high">
Generate a consolidated final report identifying ALL inconsistencies between the specification 
and actual system state. Save to `./reports/wireless-verification-[timestamp].md`.
</requirement>
</requirements>

<execution_phases>

<phase_1 name="Baseline Test">
First, run the existing test script to establish a baseline:

```powershell
# Ensure reports directory exists
New-Item -ItemType Directory -Path ".\reports" -Force

# Run comprehensive test with JSON export
.\scripts\Test-WirelessMode.ps1 -ShowAllTests -JsonOutput ".\reports\baseline-results.json"
```

Capture and analyze:
- Total pass/fail/warning counts
- Which categories have failures
- Which specific tests failed
</phase_1>

<phase_2 name="Line-by-Line Spec Verification">
Go through `docs/Wireless-Expectation.md` section by section. For EACH documented change:

**Section 1: Registry Changes**
Verify each subsection individually:

A. Dragonglass Application State (4 keys)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass" -ErrorAction SilentlyContinue | Select-Object Mode, LastAppliedUtc, EnforcerPath, DeferredToggle
```

B. Internal Tracking Keys (12+ keys including WebRTC_*)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass" -ErrorAction SilentlyContinue | Select-Object Wireless_*, WebRTC_*, Telemetry_*
```

C. Group Policy Tracking (7 keys)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass\GroupPolicy" -ErrorAction SilentlyContinue
```

D. Policy Scopes (Location, WebRTC, DNSLeak, EdgeLocation)
```powershell
Get-ChildItem -Path "HKLM:\SOFTWARE\Policies\Dragonglass" -Recurse -ErrorAction SilentlyContinue | Get-ItemProperty
```

E. Windows OS Group Policies (Network Connections, DeviceInstall)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Network Connections" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions" -ErrorAction SilentlyContinue
```

F. Location Services (HKLM)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\FindMyDevice" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location" -ErrorAction SilentlyContinue
```

G. Location Services (HKCU)
```powershell
Get-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location" -ErrorAction SilentlyContinue
```

H. WiFi Background Scan Suppression (14 keys across multiple paths)
```powershell
# NlaSvc
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\NlaSvc\Parameters\Internet" -ErrorAction SilentlyContinue

# NCSI
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\NetworkConnectivityStatusIndicator" -ErrorAction SilentlyContinue

# WcmSvc and WlanSvc
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Wcmsvc\wifinetworkmanager" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WcmSvc" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WlanSvc" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WlanSvc\Parameters" -ErrorAction SilentlyContinue

# Hotspot and WiFi Policy
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\HotspotAuthentication" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\PolicyManager\default\WiFi\AllowWiFiNetworkProbing" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\PolicyManager\default\WiFi\AllowAutoConnectToWiFiSenseHotspots" -ErrorAction SilentlyContinue
```

I. MAC Address Randomization
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WlanSvc\Randomization" -ErrorAction SilentlyContinue
Get-ChildItem -Path "HKLM:\SOFTWARE\Microsoft\WlanSvc\Interfaces" -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ItemProperty -Path $_.PSPath -Name "EnableRandomization", "RandomMacState" -ErrorAction SilentlyContinue
}
```

J. Browser Privacy Policies (Chrome, Edge, Brave, Firefox)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Edge" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Mozilla\Firefox" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\Permissions\Location" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS" -ErrorAction SilentlyContinue
```

K. IPv6 Disabling
```powershell
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters" -Name "DisabledComponents" -ErrorAction SilentlyContinue
```

L. Timezone Management (if enabled)
```powershell
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass" -Name "TimezoneManualEnabled", "TimezoneWindowsId", "TimezoneOriginalBackup", "TimezoneAutoUpdateOriginal" -ErrorAction SilentlyContinue
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate" -Name "Start" -ErrorAction SilentlyContinue
```

M. Driver-Level Wi-Fi Hardening (Vendor-Specific - Intel, Realtek, Qualcomm, Broadcom, MediaTek)
```powershell
# Get all network adapter class instances and check for driver hardening keys
Get-ChildItem -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E972-E325-11CE-BFC1-08002BE10318}" -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    if ($props.DriverDesc -match "Wi-Fi|Wireless|WLAN") {
        [PSCustomObject]@{
            Path = $_.PSPath
            Driver = $props.DriverDesc
            GlobalBGScanBlocking = $props.GlobalBGScanBlocking
            RoamAggressiveness = $props.RoamAggressiveness
            RoamingDecision = $props.RoamingDecision
            ScanType = $props.ScanType
            BgScanEnabled = $props.BgScanEnabled
            RoamScanEnabled = $props.RoamScanEnabled
            RoamTrigger = $props.RoamTrigger
            BGScan = $props.BGScan
        }
    }
}
```

N. Network Profile Registry Clearing (verify these paths are empty or minimal)
```powershell
(Get-ChildItem -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles" -ErrorAction SilentlyContinue).Count
(Get-ChildItem -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\Signatures\Unmanaged" -ErrorAction SilentlyContinue).Count
(Get-ChildItem -Path "HKLM:\SOFTWARE\Microsoft\WlanSvc\Profiles" -ErrorAction SilentlyContinue).Count
```

**Section 2: Network Adapter Changes**
```powershell
# Wi-Fi adapters enabled
Get-NetAdapter | Where-Object { $_.InterfaceDescription -match "Wi-Fi|Wireless|WLAN" -and $_.InterfaceDescription -notmatch "Direct" } | Select-Object Name, Status

# Ethernet adapters disabled
Get-NetAdapter | Where-Object { $_.MediaType -eq "802.3" -and $_.InterfaceDescription -notmatch "Virtual|VMware" } | Select-Object Name, Status

# Wi-Fi Direct disabled
Get-NetAdapter | Where-Object { $_.InterfaceDescription -match "Wi-Fi Direct" } | Select-Object Name, Status

# IPv6 binding disabled
Get-NetAdapterBinding -ComponentID "ms_tcpip6" -ErrorAction SilentlyContinue | Select-Object Name, Enabled

# WLAN AutoConfig state
netsh wlan show settings
```

**Section 3: Service Changes**
```powershell
Get-Service -Name "WlanSvc", "DiagTrack", "lfsvc", "BthServ", "tzautoupdate" -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType
```

**Section 4: Firewall Rules**
```powershell
# WebRTC Block rules
Get-NetFirewallRule -DisplayGroup "Dragonglass WebRTC Block" -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction, Action

# Telemetry Block rules (verify ALL 9 IP ranges from spec)
Get-NetFirewallRule -DisplayGroup "Dragonglass Telemetry Block" -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled

# Weather/Widgets rules
Get-NetFirewallRule -DisplayName "Dragonglass Block Windows Weather" -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "Dragonglass Block Windows Widgets" -ErrorAction SilentlyContinue
```

**Section 5: DNS Configuration**
```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" } | Select-Object InterfaceAlias, ServerAddresses
```

**Section 6: Hosts File (50+ entries)**
```powershell
$hostsContent = Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" -Raw

# Check for marker
$hostsContent -match "START Dragonglass Location Blocking"

# Check all required entries (count them)
$requiredHosts = @(
    "ntp.msn.com", "www.msn.com", "assets.msn.com",
    "tile-service.weather.microsoft.com", "inference.location.live.net",
    "v10.events.data.microsoft.com", "v10c.events.data.microsoft.com",
    "watson.telemetry.microsoft.com", "watson.microsoft.com",
    "www.bing.com", "bing.com", "api.bing.com",
    "account.microsoft.com", "account.live.com",
    "here.com", "skyhookwireless.com", "location.services.mozilla.com",
    "weather.microsoft.com", "widgets.microsoft.com"
    # ... verify ALL 50+ entries from spec
)

foreach ($host in $requiredHosts) {
    if ($hostsContent -match "127\.0\.0\.1\s+$([regex]::Escape($host))") {
        Write-Host "[PASS] $host"
    } else {
        Write-Host "[FAIL] $host NOT FOUND"
    }
}
```

**Section 7: Scheduled Tasks (8 tasks)**
```powershell
$requiredTasks = @(
    "Dragonglass Enforcer",
    "Dragonglass Network Connect",
    "Dragonglass System Resume",
    "Dragonglass Edge Privacy Enforcement",
    "Dragonglass DNS Leak Protection",
    "Dragonglass Timezone Protection",
    "Dragonglass WiFi Cache Cleaner",
    "Dragonglass System Restore"
)

foreach ($task in $requiredTasks) {
    Get-ScheduledTask -TaskPath "\Dragonglass\" -TaskName $task -ErrorAction SilentlyContinue | Select-Object TaskName, State
}
```

**Section 8: File System Changes**
```powershell
# Enforcer binary
Test-Path "$env:ProgramData\Dragonglass\bin\dragonglass-enforcer.exe"

# Telemetry config
Test-Path "$env:ProgramData\Dragonglass\telemetry_ip_ranges.json"

# Firefox policies (both paths)
Test-Path "$env:ProgramFiles\Mozilla Firefox\distribution\policies.json"
Test-Path "${env:ProgramFiles(x86)}\Mozilla Firefox\distribution\policies.json"

# Log directory
Test-Path "$env:ProgramData\Dragonglass\logs"
```

**Section 9: Wi-Fi Specific Changes**
```powershell
# WLAN interfaces
netsh wlan show interfaces

# Wi-Fi profiles
netsh wlan show profiles

# Allowed SSIDs
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass" -Name "Wireless_AllowedSSIDs" -ErrorAction SilentlyContinue
```

**Section 10: Power Settings**
```powershell
powercfg /query SCHEME_CURRENT SUB_WIFI 2>&1
```

**Section 11: Widgets & Weather Blocking (OR Logic - pass if ANY method active)**
```powershell
# Method 1: TaskbarDa
$m1 = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "TaskbarDa" -ErrorAction SilentlyContinue).TaskbarDa -eq 0

# Method 2: TaskbarWeatherEnabled
$m2 = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "TaskbarWeatherEnabled" -ErrorAction SilentlyContinue).TaskbarWeatherEnabled -eq 0

# Method 3: AllowNewsAndInterests
$m3 = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Dsh" -Name "AllowNewsAndInterests" -ErrorAction SilentlyContinue).AllowNewsAndInterests -eq 0

"Widgets blocking active: $($m1 -or $m2 -or $m3)"

# Weather app (conditional on installation)
$bingWeather = Get-AppxPackage -Name 'Microsoft.BingWeather' -AllUsers -ErrorAction SilentlyContinue
if ($bingWeather) {
    "BingWeather installed - verifying blocking..."
    Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications\Microsoft.BingWeather_8wekyb3d8bbwe" -ErrorAction SilentlyContinue
} else {
    "BingWeather not installed - blocking not required (PASS)"
}

# Process check
Get-Process -Name "Widgets", "WebViewHost" -ErrorAction SilentlyContinue
```

**Section 12: Bluetooth Handling**
```powershell
# BthServ should NOT be disabled in Wireless mode
Get-Service -Name "BthServ" -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType

# Bluetooth devices should be enabled
Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue
```

**Section 13: System Restore Integration**
```powershell
# System Restore enabled
Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore" -Name "DisableSR" -ErrorAction SilentlyContinue

# Dragonglass System Restore settings
Get-ItemProperty -Path "HKLM:\SOFTWARE\Dragonglass\SystemRestore" -ErrorAction SilentlyContinue

# Scheduled task
Get-ScheduledTask -TaskPath "\Dragonglass\" -TaskName "Dragonglass System Restore" -ErrorAction SilentlyContinue

# Dragonglass restore points
Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Where-Object { $_.Description -like '*Dragonglass*' }
```
</phase_2>

<phase_3 name="Gap Analysis">
Compare Test-WirelessMode.ps1 against Wireless-Expectation.md to identify:
1. Tests in the script NOT in the spec (obsolete?)
2. Items in the spec NOT tested by the script (coverage gaps)
3. Tests checking wrong expected values

Document each gap precisely with:
- What is missing
- Which line of the spec it corresponds to
- Suggested test code to add
</phase_3>

<phase_4 name="Update Test Script">
Update `scripts/Test-WirelessMode.ps1` to achieve 100% spec coverage:
1. Add any missing test coverage
2. Fix any incorrect expected values
3. Follow existing patterns: `Test-RegistryExpectedValue`, `Add-TestResult`
4. Group by 13 categories matching the spec
5. Ensure all telemetry IPs, hosts entries, and scheduled tasks are tested
</phase_4>

<phase_5 name="Generate Final Report">
Create `./reports/wireless-verification-[timestamp].md`:

```markdown
# Dragonglass Wireless Mode Verification Report

**Generated:** [timestamp]
**System Mode:** wireless
**Dragonglass Version:** [from registry]
**Test Script Version:** [after updates]

## Executive Summary

| Category | Total | Passed | Failed | Warnings |
|----------|-------|--------|--------|----------|
| 1. Registry | X | X | X | X |
| 2. Network Adapters | X | X | X | X |
| ... | ... | ... | ... | ... |
| **TOTAL** | **X** | **X** | **X** | **X** |

## Critical Failures (Potential Bugs)

| # | Category | Setting | Expected | Actual | Spec Line |
|---|----------|---------|----------|--------|-----------|
| 1 | ... | ... | ... | ... | ... |

## Warnings (Review Recommended)

| # | Category | Setting | Details |
|---|----------|---------|---------|
| 1 | ... | ... | ... |

## Test Script Updates Made

- Added X new tests
- Fixed X incorrect expected values
- Coverage: Y% → 100%

Changes made:
1. [Description of change]
2. ...

## Bug Investigation Recommendations

1. **[BUG-001]** [Description] - Priority: HIGH
   - Expected: ...
   - Actual: ...
   - Suggested fix: ...

## Appendix: Full Test Results

[Include complete pass/fail list for reference]
```
</phase_5>
</execution_phases>

<constraints>
<must_do>
- Run ACTUAL PowerShell commands to verify system state
- Verify EVERY item in the 793-line specification document
- Create the reports directory if it doesn't exist
- Run with Administrator privileges
- Record both expected and actual values for every check
- Update Test-WirelessMode.ps1 with missing coverage
- Produce actionable bug report
</must_do>

<must_not_do>
- Do NOT skip any section of the specification
- Do NOT assume values are correct without running verification commands
- Do NOT modify any system state (read-only verification)
- Do NOT delete tests unless they test definitively removed features
- Do NOT mark items as passed without actual verification
- Do NOT use placeholder values in the report
</must_not_do>
</constraints>

<success_criteria>
1. Every single item (210+) in Wireless-Expectation.md has been individually verified via PowerShell
2. Test-WirelessMode.ps1 is updated to include 100% coverage of the specification
3. A comprehensive markdown report exists at ./reports/wireless-verification-[timestamp].md
4. The report clearly identifies which items FAILED and may indicate bugs
5. No items in the specification are left unverified
6. User can use the report to create prioritized bug fix tasks
</success_criteria>
