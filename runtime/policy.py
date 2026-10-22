import math


class InputError(ValueError):
    pass


def inputs_from(body, config):
    if not isinstance(body, dict):
        raise InputError("JSON object required")
    if body.get("model", config["model"]) != config["model"]:
        raise InputError("Unknown model")
    value = body.get("input")
    texts = [value] if isinstance(value, str) else value
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) and t.strip() for t in texts):
        raise InputError("input must be a nonempty string or nonempty list of nonempty strings")
    dims = body.get("dimensions", config["dimensions"])
    if isinstance(dims, bool) or not isinstance(dims, int) or dims != config["dimensions"]:
        raise InputError("Request dimensions must match approved serving dimensions")
    if body.get("encoding_format", "float") != "float":
        raise InputError("This endpoint provides float embeddings")
    profile = config["profile"]
    kind = body.get("input_type", profile.get("default_input_type"))
    prompts = profile.get("prompts", {})
    if kind is not None and kind not in prompts:
        raise InputError("Unknown input_type; inspect /info for model prompts")
    prompt = prompts.get(kind, "")
    return [prompt + text for text in texts]


def check_lengths(lengths, limit):
    if not lengths or any(n <= 0 or n > limit for n in lengths):
        raise InputError(f"Input exceeds approved context_window={limit}; automatic truncation is disabled")


def project(vectors, config):
    native, dims = config["native_dimensions"], config["dimensions"]
    result = []
    for vector in vectors:
        v = [float(x) for x in vector]
        if len(v) != native or not all(math.isfinite(x) for x in v):
            raise ValueError(f"Backend vector violates native dimension/finite contract ({len(v)} vs {native})")
        if config["profile"].get("layer_norm_before_truncate"):
            mean = sum(v) / len(v)
            var = sum((x - mean) ** 2 for x in v) / len(v)
            v = [(x - mean) / math.sqrt(var + 1e-5) for x in v]
        v = v[:dims]
        if config["profile"].get("normalize"):
            norm = math.sqrt(sum(x*x for x in v))
            if not norm:
                raise ValueError("Zero embedding cannot be normalized")
            v = [x / norm for x in v]
        result.append(v)
    return result
