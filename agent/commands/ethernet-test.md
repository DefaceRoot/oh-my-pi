<objective>
Perform a comprehensive compliance verification of Ethernet mode by:
1. Manually verifying ALL system changes documented in @docs/Ethernet-Expectation.md using CLI commands
2. Running and comparing results with @scripts/Test-EthernetMode.ps1
3. Cross-referencing discrepancies against the actual codebase to determine intended behavior
4. Fixing the test script where it doesn't match codebase intent (NOT to create false passes)
5. Producing a bug report of genuine application defects

The system is currently in Ethernet mode. Your goal is to identify bugs in the Dragonglass application where system state does not match what the codebase intends.
</objective>

<context>
**Project**: Dragonglass - Windows Wi-Fi privacy control application
**Current Mode**: Ethernet (user-confirmed)
**Reference Document**: @docs/Ethernet-Expectation.md (681 lines, 11 categories, ~180+ system changes)
**Test Script**: @scripts/Test-EthernetMode.ps1 (1538 lines)

**Key Codebase Files for Cross-Reference**:
- `app/src-tauri/src/core/controller/mode_application/ethernet.rs` - Main app Ethernet mode application
- `enforcer/src/enforcement/orchestrator.rs` - Boot-time enforcer entry point
- `enforcer/src/enforcement/mode_enforcement.rs` - Group policy and Windows OS policy enforcement
- `enforcer/src/enforcement/dns_enforcement.rs` - DNS leak protection
- `enforcer/src/enforcement/location_enforcement.rs` - Location protection
- `app/src-tauri/src/privacy/dns_leak/manager.rs` - DNS leak manager
- `app/src-tauri/src/network/wifi/manager.rs` - Wi-Fi adapter management
- `app/src-tauri/src/network/services.rs` - Service control (WlanSvc, DiagTrack)

**Division of Responsibilities**:
- **Main App**: Adapter enable/disable, service control (WlanSvc), Wi-Fi cache clearing, MAC randomization, initial privacy protections, scheduled task creation
- **Enforcer**: Re-applies protection policies at boot/events (DNS, location, GPO, firewall rules, device install restrictions)

**Ethernet Mode Specifics**:
- Wi-Fi adapters should be DISABLED
- Ethernet adapters should be ENABLED
- WlanSvc should be STOPPED and DISABLED
- WiFi scan suppression registry keys are NOT applied (Wi-Fi is disabled)
- Driver-level scan suppression IS applied
- Bluetooth should remain ENABLED
</context>

<requirements>
<requirement priority="critical">
**Phase 1: Manual CLI Verification**

Go through EVERY category in @docs/Ethernet-Expectation.md and verify system state using PowerShell/CLI commands.

Categories to verify (all 11):
1. Registry Changes (Sections A-K: ~70+ HKLM keys, ~8+ HKCU keys)
2. Network Adapter Changes
3. Service Changes
4. Firewall Rules
5. DNS Configuration
6. Hosts File Modifications
7. Scheduled Tasks
8. File System Changes
9. Power Settings
10. Windows Widgets & Weather App Blocking
11. Bluetooth Handling

For each check, use appropriate CLI commands:
- Registry: `Get-ItemProperty`, `Get-ItemPropertyValue`, `Test-Path`
- Services: `Get-Service`, `sc.exe qc`
- Adapters: `Get-NetAdapter`, `Get-NetAdapterBinding`, `netsh wlan show interfaces`
- Firewall: `Get-NetFirewallRule`, `Get-NetFirewallAddressFilter`
- DNS: `Get-DnsClientServerAddress`, `ipconfig /all`
- Hosts: `Get-Content $env:SystemRoot\System32\drivers\etc\hosts`
- Tasks: `Get-ScheduledTask -TaskPath "\Dragonglass\"`
- Files: `Test-Path`, `Get-Content`
</requirement>

<requirement priority="critical">
**Phase 2: Run Test Script and Compare**

Execute `scripts\Test-EthernetMode.ps1` and capture output:
```powershell
.\scripts\Test-EthernetMode.ps1 -ShowAllTests -JsonOutput "$env:TEMP\ethernet-test-results.json"
```

Compare script results against your manual CLI findings. Document any cases where:
- Script passes but your CLI check failed
- Script fails but your CLI check passed
- Script tests something not in the document
- Document specifies something the script doesn't test
</requirement>

<requirement priority="critical">
**Phase 3: Codebase Cross-Reference for Discrepancies**

When you find a discrepancy between:
- Document expectation vs actual system state
- Script expectation vs actual system state
- Your CLI findings vs script findings

You MUST dig into the codebase to determine the INTENDED behavior:
1. Read the relevant Rust source files
2. Trace the code path for that specific setting
3. Determine what the code ACTUALLY does
4. Decide: Is this a bug in the app, a bug in the script, or a documentation error?
</requirement>

<requirement priority="critical">
**Phase 4: Fix Test Script (If Needed)**

Update @scripts/Test-EthernetMode.ps1 to properly test Ethernet mode functionality.

**Rules for script fixes**:
- Match codebase conditional logic (e.g., if BingWeather location denial only applies when BingWeather is installed, the script should check the same condition)
- NEVER create false passes - the script exists to find bugs
- Add missing tests for documented features the script doesn't cover
- Remove or fix tests that don't match codebase intent
- Preserve the existing script structure and helper functions

**Conditional Logic Examples from Codebase**:
- Weather app HKLM location key: Only created if Microsoft.BingWeather package is installed
- Widgets blocking: Uses OR logic (any of 3 methods active = blocked)
- WiFi scan suppression keys: NOT applied in Ethernet mode (Wi-Fi is disabled)
- Timezone management: Only checked if TimezoneManualEnabled = "1"
</requirement>

<requirement priority="high">
**Phase 5: Bug Report**

Produce a consolidated bug report with ONLY genuine application defects where:
- The codebase clearly intends to set a value, but the system state doesn't match
- A documented protection is not being applied despite code existing for it
- The enforcer or main app fails to apply a specific change

**Do NOT report as bugs**:
- Documentation errors (document says X, code doesn't do X by design)
- Environmental differences (hardware not present, optional features)
- Pre-existing system state (values set before Dragonglass was installed)
</requirement>
</requirements>

<output_format>
**Discrepancy-Focused Reporting**

For each category, provide:
```
## Category N: [Category Name]

**Summary**: X/Y checks passed

**Failures/Discrepancies**:
| Setting | Expected | Actual | CLI Command | Verdict |
|---------|----------|--------|-------------|---------|
| [name]  | [value]  | [value]| [command]   | BUG/SCRIPT_FIX/DOC_ERROR |

**Passes**: [Brief summary or count]
```

**Final Bug Report Format**:
```
# Ethernet Mode Bug Report

## Summary
- Total bugs found: N
- Categories affected: [list]

## Bug Details

### BUG-001: [Short Description]
- **Category**: [N. Category Name]
- **Expected Behavior**: [What should happen per codebase]
- **Actual Behavior**: [What actually happens]
- **Code Reference**: [File:line showing intended behavior]
- **Verification Command**: [CLI command to reproduce]
- **Severity**: HIGH/MEDIUM/LOW
```
</output_format>

<constraints>
<constraint type="critical">
NEVER modify the test script just to make tests pass. The script's purpose is to FIND bugs in the application.
</constraint>

<constraint type="critical">
Always cross-reference the CODEBASE before declaring something a bug. The document may be outdated or incorrect.
</constraint>

<constraint type="important">
Use the same conditional logic as the codebase. If the code checks "is BingWeather installed?" before creating a registry key, the test should too.
</constraint>

<constraint type="important">
Report bugs to the user - do NOT attempt to fix application code. A separate agent will handle bug fixes.
</constraint>

<constraint type="important">
Be thorough but efficient. Don't re-verify things that are clearly passing. Focus investigation time on discrepancies.
</constraint>
</constraints>

<verification>
Before declaring the task complete, verify:
- [ ] All 11 categories in Ethernet-Expectation.md have been checked via CLI
- [ ] Test-EthernetMode.ps1 has been executed and results compared
- [ ] All discrepancies have been cross-referenced against codebase
- [ ] Test script has been updated if needed (with explanatory comments)
- [ ] Final bug report is produced with only genuine application defects
- [ ] Each reported bug includes code reference showing intended behavior
</verification>

<success_criteria>
1. Comprehensive CLI verification of all 11 categories completed
2. Test script output compared against manual findings
3. Every discrepancy traced to root cause (app bug, script bug, or doc error)
4. Test script updated to match codebase conditional logic
5. Bug report contains ONLY genuine application defects with code references
6. No false positives (things reported as bugs that are actually working as intended)
</success_criteria>
