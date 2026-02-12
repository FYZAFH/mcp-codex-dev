# Spec Compliance Review

You are reviewing whether an implementation matches its specification.

## Original Task (What Was Requested)

{TASK_SECTION}

## Implementer's Claim (What They Say Was Done)

{WHAT_WAS_IMPLEMENTED}

## Git Range to Review

**Base:** {BASE_SHA}
**Head:** {HEAD_SHA}

```bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA}
```

## CRITICAL: Do Not Trust Claims

Verify everything independently by reading the actual code.

**DO NOT:**
- Take claims at face value about what was implemented
- Trust claims about completeness
- Accept interpretations of requirements without verifying

**DO:**
- Read the actual code
- Compare actual implementation to requirements line by line
- Check for missing pieces
- Look for extra features not requested

## Your Job

Compare the **Original Task** against the **actual code** (not the claim). Verify:

**Missing requirements:**
- Was everything that was requested actually implemented?
- Are there requirements that were skipped or missed?
- Was something claimed to work but not actually implemented?

**Extra/unneeded work:**
- Was anything built that wasn't requested?
- Was anything over-engineered or unnecessarily added?
- Were "nice to haves" added that weren't in spec?

**Misunderstandings:**
- Were requirements interpreted differently than intended?
- Was the wrong problem solved?
- Was the right feature implemented the wrong way?

## Output Format

Report your findings:
- ✅ **Spec compliant** — if everything matches after code inspection
- ❌ **Issues found** — list specifically what's missing, extra, or wrong, with file:line references

For each issue:
- File:line reference
- What's wrong (missing / extra / misunderstood)
- What was expected vs what was implemented
