"""Dev-only tokenizer measurements; install tiktoken==0.12.0 in a local venv.
Run: python scripts/benchmark-adr-compaction.py
No model calls. Prices below are illustrative, not provider quotations.
"""
import json
import subprocess
from pathlib import Path
import tiktoken

root = Path(__file__).resolve().parent.parent
fixtures = json.loads(subprocess.check_output(["bun", "scripts/benchmark-adr-compaction.ts"], cwd=root))
encoder = tiktoken.get_encoding("cl100k_base")

def tokens(text):
    return len(encoder.encode(text, disallowed_special=()))

rows = []
for fixture in fixtures:
    draft = [tokens(page) for page in fixture["draftPages"]]
    warm = [tokens(page) for page in fixture["warmPages"]]
    baseline = tokens(fixture["targetedBaseline"])
    evidence = sum(draft)
    summary_output = tokens(fixture["summary"])
    saved = baseline - sum(warm)
    initial_lower_usd = evidence / 1_000_000 + summary_output * 5 / 1_000_000
    rows.append({
        "records": fixture["count"], "read_all_tokens": tokens(fixture["raw"]),
        "targeted_baseline_tokens": baseline, "warm_evidence_tokens": sum(warm),
        "warm_pages": len(warm), "max_page_characters": fixture["maxPageCharacters"],
        "draft_evidence_tokens_once": evidence,
        "naive_replayed_draft_evidence_tokens": sum(n * (len(draft) - i) for i, n in enumerate(draft)),
        "summary_output_tokens": summary_output,
        "fixture_constraint_recall": f'{fixture["recalled"]}/{fixture["needed"]}',
        "warm_reduction_vs_targeted_percent": round(saved / baseline * 100, 1),
        "initial_cost_floor_usd_at_1_input_5_output": round(initial_lower_usd, 4),
        "amortization_tasks_lower_bound": None if saved <= 0 else round(initial_lower_usd / (saved / 1_000_000), 1),
    })
print(json.dumps({"tokenizer": "tiktoken 0.12.0 / cl100k_base", "model_calls": 0,
                  "warning": "Synthetic oracle summaries. Recall is fixture coverage, NOT LLM semantic faithfulness. Draft cost excludes prompts, tool definitions, review, replacements, retry and replay overhead. Replay column assumes no cache or session compaction. No fixed saving claim.",
                  "rows": rows}, indent=2))
