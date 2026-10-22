from __future__ import annotations

import json
from pathlib import Path

from .common import ROOT, digest, fingerprint_model, load, now, save


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def inspect_model(model):
    root = Path(model).resolve()
    config = read_json(root / "config.json")
    text = config.get("text_config", config)
    st = read_json(root / "config_sentence_transformers.json")
    transformer = read_json(root / "sentence_bert_config.json")
    tokenizer = read_json(root / "tokenizer_config.json")
    modules = read_json(root / "modules.json") or []
    dimension = text.get("embedding_dim", text.get("hidden_size", text.get("n_embd")))
    pooling = None
    for m in modules:
        cfg = read_json(root / m["path"] / "config.json")
        if m["type"].endswith("Pooling"):
            dimension = cfg.get("word_embedding_dimension", dimension)
            pooling = next((name for name, flag in (("mean", "pooling_mode_mean_tokens"), ("cls", "pooling_mode_cls_token"),
                                                    ("last-token", "pooling_mode_lasttoken")) if cfg.get(flag)), None)
        if m["type"].endswith("Dense"):
            dimension = cfg.get("out_features", dimension)
    lengths = {"sentence_bert_config.json:max_seq_length": transformer.get("max_seq_length"),
               "tokenizer_config.json:model_max_length": tokenizer.get("model_max_length"),
               "config.json:text.max_position_embeddings": text.get("max_position_embeddings")}
    defaults = load(ROOT / "config/model_defaults.yaml").get(root.name, {})
    # Model cards can impose shorter trained limits than position/config capacity.
    context = defaults.get("context_window") or transformer.get("max_seq_length")
    if not context:
        finite = [x for x in lengths.values() if isinstance(x, int) and 0 < x < 1_000_000]
        context = min(finite) if finite else None
    dimension = defaults.get("native_dimensions", dimension)
    prompts = defaults.get("prompts", st.get("prompts", {}))
    return {"schema": "embedding-model/1", "model": root.name, "path": str(root), "inspected_at": now(),
            "fingerprint": fingerprint_model(root), "architecture": config.get("architectures"),
            "model_type": config.get("model_type"), "modules": modules, "pooling": pooling,
            "checkpoint_dtype": text.get("dtype", text.get("torch_dtype", config.get("torch_dtype"))),
            "context_candidates": lengths, "recommended_context_window": context,
            "native_dimensions": dimension, "reduction": defaults.get("reduction", {"supported": False, "reason": "No confirmed model recommendation; retain native."}),
            "prompts": prompts, "default_input_type": defaults.get("default_input_type", "query" if "query" in prompts else None),
            "normalize": defaults.get("normalize", any(m["type"].endswith("Normalize") for m in modules)),
            "layer_norm_before_truncate": defaults.get("layer_norm_before_truncate", False),
            "requires_model_adapter": defaults.get("requires_model_adapter"),
            "source": {"files": [str(root / p) for p in ["config.json", "modules.json", "README.md"] if (root / p).exists()],
                       "curated": defaults.get("source"), "settings_without_recommendation": "engine default; validate at runtime"}}


def approve(model, manifest, device, context_window, dimensions, approval_reference, output):
    if not approval_reference.strip():
        raise ValueError("A real user approval reference is required; do not synthesize approval.")
    if device not in {"cpu", "gpu"} or isinstance(context_window, bool) or context_window <= 0:
        raise ValueError("Choose CPU/GPU and a positive context_window.")
    profile = inspect_model(model)
    limit = profile["recommended_context_window"]
    if limit is None or context_window > limit:
        raise ValueError(f"Requested context {context_window} lacks model support evidence (recommended upper bound {limit}).")
    native = profile["native_dimensions"]
    dims = native if dimensions == "native" else int(dimensions)
    if not isinstance(native, int) or not 0 < dims <= native:
        raise ValueError("Output dimension must be known and within model capacity.")
    reduction = profile["reduction"]
    if dims != native:
        valid = reduction.get("supported") and (dims in reduction.get("choices", []) or
                reduction.get("min", native) <= dims <= reduction.get("max", 0))
        if not valid:
            raise ValueError("Dimension reduction is not confirmed for this model/value.")
    manifest_data = load(manifest)
    manifest_digest = digest(manifest_data)
    manifest_snapshot = Path(output).resolve() / "host" / "manifests" / (manifest_digest + ".yaml")
    if manifest_snapshot.exists() and digest(load(manifest_snapshot)) != manifest_digest:
        raise ValueError("Existing manifest snapshot was modified; preserve and investigate it before continuing.")
    if not manifest_snapshot.exists():
        save(manifest_snapshot, manifest_data)
    strategy = {"schema": "embedding-strategy/1", "approved_at": now(), "approval_reference": approval_reference,
                "model": profile["model"], "model_path": profile["path"], "model_fingerprint": profile["fingerprint"],
                "manifest_path": str(manifest_snapshot), "manifest_source_path": str(Path(manifest).resolve()), "manifest_digest": manifest_digest,
                "device": device, "context_window": context_window, "dimensions": dims,
                "native_dimensions": native, "api": "/v1/embeddings", "input_policy": "reject_over_limit",
                "engine_policy": "tei_first_then_sentence_transformers_same_device", "profile": profile}
    strategy["id"] = digest(strategy)[:16]
    path = Path(output) / profile["model"] / "strategies" / (strategy["id"] + ".yaml")
    save(path, strategy)
    return {"strategy": str(path.resolve()), "id": strategy["id"], "device": device,
            "context_window": context_window, "dimensions": dims}
