#!/usr/bin/env python3
"""Fetch provider model catalog from models.opencode.ai and suggest tier assignments.

Usage:
    python scripts/fetch-provider.py <provider_id>

Output: JSON with provider info, all models, and suggested tier picks.
"""
import json
import sys
import urllib.request

API_URL = "https://models.opencode.ai/api.json"
TIER_KEYWORDS = {
    "flash":      ["flash", "haiku", "mini", "lite", "turbo", "nano", "small", "highspeed"],  # cheapest/fastest
    "standard":   ["pro", "max", "plus", "chat", "sonnet", "flash"],  # high-traffic main agent & orchestration
    "pro":        ["codestral", "coder", "sonnet", "pro", "max", "large"],  # professional full-stack development
    "max":        ["opus", "max", "large", "ultra", "pro", "reasoner", "r1", "thinking"],  # flagship reasoning & decision
}

# Keywords that indicate flagship / highest-quality models — used to exclude them from standard tier
FLAGSHIP_KEYWORDS = ["opus", "ultra", "reasoner", "r1"]
# Keywords that indicate cheap/fast models — used to exclude them from standard tier
CHEAP_KEYWORDS = ["nano", "small", "highspeed"]

SMALL_RE = __import__("re").compile(r"\b(nano|flash|lite|mini|haiku|small|fast|turbo|highspeed)\b")


def fetch_catalog():
    req = urllib.request.Request(API_URL, headers={"User-Agent": "opencode-profile-manager/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def model_score(model_id, model_data, tier):
    name_lower = f"{model_id} {model_data.get('family', '')} {model_data.get('name', '')}".lower()
    keywords = TIER_KEYWORDS.get(tier, [])
    score = 0
    for kw in keywords:
        if kw in name_lower:
            score += 1
    # standard tier: penalize ultra flagship (should use max) and ultra cheap (should use pro/flash)
    if tier == "standard":
        for kw in FLAGSHIP_KEYWORDS:
            if kw in name_lower:
                score -= 2
        for kw in CHEAP_KEYWORDS:
            if kw in name_lower:
                score -= 1
    cost = model_data.get("cost", {})
    cost_val = (cost.get("input", 0) + cost.get("output", 0)) if cost else 0
    status = model_data.get("status", "")
    if status in ("deprecated",):
        score -= 100
    return score, cost_val


def pick_tier(models, tier):
    candidates = []
    for mid, mdata in models.items():
        score, cost = model_score(mid, mdata, tier)
        candidates.append((mid, score, cost, mdata))
    candidates.sort(key=lambda x: (x[1], -x[2]), reverse=True)
    return candidates[0] if candidates else None


def pick_vision(models):
    for mid, mdata in models.items():
        if mdata.get("attachment", False):
            mods = mdata.get("modalities", {})
            if "image" in mods.get("input", []):
                return mid, mdata
    return None


BLACKLIST = [
    "alibaba", "alibaba-cn",
    "minimax", "minimax-cn",
    "moonshotai", "moonshotai-cn",
    "zhipuai", "zai",
    "stepfun", "stepfun-ai",
    "stepfun-step-plan", "stepfun-ai-step-plan",
    "xiaomi",
    "tencent-tokenhub",
    "mistral",
]

EXCEPTIONS = ["deepseek"]

PLAN_SUGGESTIONS = {
    "alibaba": "alibaba-token-plan",
    "alibaba-cn": "alibaba-token-plan-cn",
    "minimax": "minimax-coding-plan",
    "minimax-cn": "minimax-cn-coding-plan",
    "moonshotai": "kimi-for-coding",
    "moonshotai-cn": "kimi-for-coding",
    "zhipuai": "zhipuai-coding-plan",
    "zai": "zai-coding-plan",
    "stepfun": "stepfun-step-plan",
    "stepfun-ai": "stepfun-ai-step-plan",
    "xiaomi": "xiaomi-token-plan-cn",
}


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch-provider.py <provider_id>", file=sys.stderr)
        sys.exit(1)

    provider_id = sys.argv[1]

    if provider_id in BLACKLIST and provider_id not in EXCEPTIONS:
        suggestion = PLAN_SUGGESTIONS.get(provider_id, "none")
        print(json.dumps({
            "error": f"Provider '{provider_id}' is blacklisted — no subscription plan (coding plan / token plan).",
            "reason": "Only providers that ARE a subscription plan are kept. Base API providers are skipped.",
            "suggested_plan": suggestion,
        }, indent=2, ensure_ascii=False))
        sys.exit(1)

    catalog = fetch_catalog()

    if provider_id not in catalog:
        # Suggest closest matches
        all_ids = sorted(catalog.keys())
        matches = [p for p in all_ids if provider_id.lower() in p.lower()]
        print(json.dumps({
            "error": f"Provider '{provider_id}' not found in catalog.",
            "suggestions": matches[:20],
            "total_providers": len(all_ids),
        }, indent=2, ensure_ascii=False))
        sys.exit(1)

    provider = catalog[provider_id]
    models = provider.get("models", {})

    # Pick tiers
    picks = {}
    for tier in ["flash", "standard", "pro", "max"]:
        best = pick_tier(models, tier)
        if best:
            picks[tier] = best[0]

    vision = pick_vision(models)
    if vision:
        picks["vision"] = vision[0]

    # Build model summary
    model_list = []
    for mid, mdata in models.items():
        model_list.append({
            "id": mid,
            "name": mdata.get("name", ""),
            "family": mdata.get("family", ""),
            "attachment": mdata.get("attachment", False),
            "reasoning": mdata.get("reasoning", False),
            "tool_call": mdata.get("tool_call", False),
            "cost": (mdata.get("cost", {}) or {}).get("input", 0),
            "status": mdata.get("status", ""),
            "release_date": mdata.get("release_date", ""),
            "modalities": mdata.get("modalities", {}),
        })

    result = {
        "provider_id": provider_id,
        "provider_name": provider.get("name", ""),
        "env": provider.get("env", []),
        "npm": provider.get("npm", ""),
        "api_url": provider.get("api", ""),
        "doc_url": provider.get("doc", ""),
        "model_count": len(models),
        "suggested_tiers": picks,
        "models": model_list,
    }

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
