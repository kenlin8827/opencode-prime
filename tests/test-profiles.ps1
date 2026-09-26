#requires -Version 7.0
# test-profiles.ps1 — stress test for profiles/*.json
#
# For every bundled profile: apply it to a fresh copy of the repo template
# and assert that (a) every agent of a covered tier carries the profile ref,
# (b) the root model tracks tier.standard, (c) tiers not listed by the profile
# keep the template ref. Optionally cross-checks every ref against
# `opencode models` when the CLI is available and authenticated.
#
# Profile application is re-implemented inline (same semantics as the
# /profile plugin), so this test no longer depends on the retired
# install/config.ps1.
#
# Usage: pwsh tests/test-profiles.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$template = Join-Path $root 'opencode.template.jsonc'
$profilesDir = Join-Path $root 'profiles'
$tiersFile = Join-Path $root 'tiers.json'

# Agent → tier mapping from tiers.json (kept out of opencode.template.jsonc
# because opencode forwards unknown agent fields to the provider as model
# options).
if (-not (Test-Path $tiersFile)) { throw "tiers.json missing at repo root: $tiersFile" }
$agentTier = @{}
$tiersObj = Get-Content -Raw $tiersFile | ConvertFrom-Json
foreach ($k in $tiersObj.PSObject.Properties.Name) {
    if ($k.StartsWith('$')) { continue }
    $agentTier[$k] = [string]$tiersObj.$k
}

function Get-AgentTier($agents, [string]$name) {
    if ($agentTier.ContainsKey($name)) { return $agentTier[$name] }
    return $null
}

# Apply a profile to $obj in place: rewrite every agent of a covered tier to
# the profile ref in lockstep; root `model` tracks tier.standard. Mirrors the
# /profile plugin's applyProfile semantics.
function Apply-ProfileInPlace([hashtable]$obj, [hashtable]$p) {
    foreach ($tier in $p.tiers.Keys) {
        $ref = $p.tiers[$tier]
        $n = 0
        foreach ($aname in $obj.agents.Keys) {
            if ((Get-AgentTier $obj.agents $aname) -eq $tier) { $obj.agents[$aname].model = $ref; $n++ }
        }
        if ($n -eq 0) { throw "no agent currently uses tier $tier" }
        if ($tier -eq 'standard') { $obj['model'] = $ref }
    }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ocfg-profile-test-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
$cfg = Join-Path $tmp 'opencode.jsonc'

try {
    $tpl = Get-Content -Raw $template | ConvertFrom-Json -AsHashtable
    # expected per-tier ref in the untouched template
    $tplTierRef = @{}
    foreach ($aname in $tpl.agents.Keys) {
        $t = Get-AgentTier $tpl.agents $aname
        if ($t -and -not $tplTierRef.ContainsKey($t)) { $tplTierRef[$t] = $tpl.agents[$aname].model }
    }

    $fail = 0
    $profiles = Get-ChildItem $profilesDir -File -Recurse -Filter '*.json' | Sort-Object FullName
    # Recursive fetch (profiles may live in vendor subdirectories); show the
    # subdir-relative name so output stays unambiguous (e.g. opencode-go/deepseek).
    function Get-ProfileName($p) {
        return ($p.FullName.Substring($profilesDir.Length).TrimStart('\', '/')).Replace([System.IO.Path]::DirectorySeparatorChar, '/') -replace '\.json$', ''
    }
    foreach ($pf in $profiles) {
        Copy-Item $template $cfg -Force
        $p = Get-Content -Raw $pf.FullName | ConvertFrom-Json -AsHashtable
        try {
            $obj = Get-Content -Raw $cfg | ConvertFrom-Json -AsHashtable
            Apply-ProfileInPlace $obj $p
            $obj | ConvertTo-Json -Depth 10 | Set-Content -Path $cfg -Encoding utf8NoBOM
        } catch {
            Write-Output "[$(Get-ProfileName $pf)] FAIL apply: $_"
            $fail++
            continue
        }
        $obj = Get-Content -Raw $cfg | ConvertFrom-Json -AsHashtable
        $errors = @()
        # covered tiers: every agent must carry the profile ref
        foreach ($tier in $p.tiers.Keys) {
            $ref = $p.tiers[$tier]
            $n = 0
            foreach ($aname in $obj.agents.Keys) {
                if ((Get-AgentTier $obj.agents $aname) -eq $tier) {
                    $n++
                    if ($obj.agents[$aname].model -ne $ref) { $errors += "tier ${tier}: agent $aname model '$($obj.agents[$aname].model)' != '$ref'" }
                }
            }
            if ($n -eq 0) { $errors += "tier ${tier}: no agent matched" }
            if ($tier -eq 'standard' -and $obj.model -ne $ref) { $errors += "root model '$($obj.model)' != '$ref'" }
        }
        # uncovered tiers: agents must keep the template ref (if the template has one)
        # The template ships no model presets by design, so this check only applies
        # if the template happens to have models (e.g. user-added or legacy).
        foreach ($aname in $obj.agents.Keys) {
            $t = Get-AgentTier $obj.agents $aname
            if ($t -and -not $p.tiers.Contains($t)) {
                $expected = $tplTierRef[$t]
                if ($expected -and $obj.agents[$aname].model -ne $expected) {
                    $errors += "untouched tier ${t} ($aname): '$($obj.agents[$aname].model)' != template '$expected'"
                }
            }
        }
        if ($errors.Count -eq 0) {
            Write-Output "[$(Get-ProfileName $pf)] PASS ($($p.tiers.Count) tiers applied)"
        } else {
            Write-Output "[$(Get-ProfileName $pf)] FAIL"
            $errors | ForEach-Object { Write-Output "  - $_" }
            $fail++
        }
    }

    # guard: every bundled profile must cover all template tiers — repo
    # policy is that no tier is left dangling (vision especially)
    foreach ($pf2 in $profiles) {
        $p2 = Get-Content -Raw $pf2.FullName | ConvertFrom-Json -AsHashtable
        $missingTiers = @($tplTierRef.Keys | Where-Object { -not $p2.tiers.Contains($_) })
        if ($missingTiers.Count -gt 0) {
            Write-Output "[$(Get-ProfileName $pf2)] FAIL coverage: missing tier(s) $($missingTiers -join ', ')"
            $fail++
        }
    }

    # model existence check against `opencode models`
    Write-Output ''
    Write-Output '--- model existence vs `opencode models` ---'
    $available = @()
    if (Get-Command opencode -ErrorAction SilentlyContinue) {
        $available = @(opencode models 2>$null | Where-Object { $_ -match '^[^/]+/' } | ForEach-Object { $_.Trim() })
    }
    if ($available.Count -eq 0) {
        Write-Output 'opencode CLI unavailable or unauthenticated — existence check SKIPPED'
    } else {
        Write-Output "opencode lists $($available.Count) models"
        foreach ($pf in $profiles) {
            $p = Get-Content -Raw $pf.FullName | ConvertFrom-Json -AsHashtable
            $missing = @($p.tiers.Values | Where-Object { $available -notcontains $_ })
            if ($missing.Count -eq 0) {
                Write-Output "[$(Get-ProfileName $pf)] all refs exist"
            } else {
                Write-Output "[$(Get-ProfileName $pf)] MISSING: $($missing -join ', ')"
            }
        }
    }

    Write-Output ''
    if ($fail -eq 0) { Write-Output "RESULT: ALL PASS ($($profiles.Count) profiles)"; exit 0 }
    Write-Output "RESULT: $fail profile(s) FAILED"
    exit 1
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
