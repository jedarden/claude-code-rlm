# Bead Worker Configuration Investigation Report

## Task: bf-46q
**Title**: Investigate bead worker configuration
**Date**: 2026-07-04
**Workspace**: `/home/coding/claude-code-rlm`

---

## Executive Summary

Investigated all configuration settings affecting bead discovery by the Pluck worker. **CRITICAL ANOMALY IDENTIFIED**: The global NEEDLE configuration points to a different workspace than the current bead's location.

---

## Configuration Documentation

### 1. Global NEEDLE Configuration (`~/.config/needle/config.yaml`)

#### Pluck Strand Configuration
```yaml
strands:
  pluck:
    exclude_labels: []           # ← No labels are excluded
    split_after_failures: 3
```

**Status**: ✅ Empty array means all labels are eligible for processing

#### Workspace Configuration
```yaml
workspace:
  default: /home/coding/zai-proxy    # ← CRITICAL ISSUE
  home: /home/coding/.needle
  labels: []
```

**Status**: ⚠️ **ANOMALY** - Default workspace does NOT match current workspace

#### Worker Configuration
```yaml
worker:
  max_workers: 17
  launch_stagger_seconds: 2
  idle_timeout: 60
  idle_action: wait
  identifier_scheme: hostname_random
  # ... (other settings)
```

**Status**: ✅ Standard fleet configuration

---

### 2. Workspace-Level Configuration (`.beads/config.yaml`)

```yaml
issue_prefixes: [bf]
default_priority: 2
default_type: task
claim_ttl_minutes: 30
```

**Status**: ✅ Standard br/bead-forge workspace configuration  
**Note**: This file does NOT support `exclude_labels` - that's a NEEDLE-level setting

---

### 3. Workspace-Level NEEDLE Override (`.needle.yaml`)

**Status**: ⚠️ **MISSING** - No `.needle.yaml` exists in `/home/coding/claude-code-rlm`

**Impact**: Workspace inherits all global defaults, including the incorrect `workspace.default` path

---

### 4. Current Bead Status (bf-46q)

```json
{
  "id": "bf-46q",
  "status": "in_progress",
  "assignee": "claude-code-glm47-lima",
  "labels": ["deferred", "failure-count:1", "split-child"]
}
```

**Status**: ⚠️ Bead has `deferred` label but NEEDLE's `exclude_labels` is empty, so this should NOT prevent discovery

---

## CRITICAL ANOMALY: Workspace Path Mismatch

### Problem
| Setting | Value |
|---------|-------|
| NEEDLE `workspace.default` | `/home/coding/zai-proxy` |
| Current bead location | `/home/coding/claude-code-rlm` |
| Current ready beads in default workspace | **0** |
| Current ready beads in actual workspace | **1** (`bf-gjo`) |

### Impact
If a bead worker is invoked without explicitly specifying `-w /home/coding/claude-code-rlm`:
1. Worker reads global config → uses `workspace.default: /home/coding/zai-proxy`
2. Worker queries that workspace → finds 0 ready beads
3. Worker exits immediately or stays idle (depending on `idle_action`)

### Verification Commands Run
```bash
# Ready beads in THIS workspace (where bf-46q lives)
br ready -w /home/coding/claude-code-rlm --json
# Result: 1 ready bead (bf-gjo)

# Ready beads in DEFAULT workspace (from global config)
br ready -w /home/coding/zai-proxy --json
# Result: 0 ready beads
```

---

## Filter Configuration Summary

### Label Filters
- **Global NEEDLE config**: `strands.pluck.exclude_labels: []` ✅
- **Workspace override**: None (missing `.needle.yaml`)
- **Impact**: No labels are excluded - all beads regardless of labels should be discoverable

### Status Filters
- **Bead status**: bf-46q is `in_progress` with assignee set
- **Ready query behavior**: `br ready` only returns `open` status beads without assignee
- **Impact**: This bead is correctly NOT appearing in ready queries (it's already claimed)

### Other Filters
- **No workspace-level filters exist**
- **No additional label filters in br CLI** (`br ready` and `br claim` don't support label filtering)

---

## Recommendations

### Immediate Fix (to enable bead discovery in this workspace)
Create `.needle.yaml` in `/home/coding/claude-code-rlm`:

```yaml
workspace:
  default: /home/coding/claude-code-rlm
```

This overrides the global default for this workspace specifically.

### Alternative Fixes
1. **Update global config** (affects all workspaces):
   ```bash
   # Edit ~/.config/needle/config.yaml
   workspace.default: /home/coding/claude-code-rlm
   ```

2. **Always specify workspace explicitly** when invoking workers:
   ```bash
   br ready -w /home/coding/claude-code-rlm
   NEEDLE workers must be told which workspace to use
   ```

### Future Considerations
- If `deferred` label should exclude beads from discovery, update global config:
  ```yaml
  strands:
    pluck:
      exclude_labels: ["deferred", "human"]
  ```

---

## Configuration Hierarchy Summary

```
1. Built-in defaults
   ↓
2. Global config (~/.config/needle/config.yaml)
   ✅ workspace.default = /home/coding/zai-proxy ← WRONG for this workspace
   ✅ strands.pluck.exclude_labels = [] ← No filtering
   ↓
3. Workspace .needle.yaml
   ⚠️ MISSING ← Would override workspace.default
   ↓
4. Environment variables (NEEDLE_*)
   ↓
5. CLI arguments (-w, --workspace)
```

---

## Acceptance Criteria Status

✅ **All configuration values documented** - Complete inventory above  
✅ **Misconfigurations identified** - Workspace path mismatch found  
✅ **Report ready for next step** - This report provides action items

---

## Next Steps

Based on this investigation, the next action should be:

1. **Choose a fix approach** (workspace override vs global config update)
2. **Apply the fix** (create `.needle.yaml` or update global config)
3. **Verify bead discovery** after fix applied
4. **Close this investigation bead** (bf-46q)
