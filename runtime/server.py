from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from .policy import InputError, check_lengths, inputs_from, project


class TEIBackend:
    def __init__(self, config):
        from tokenizers import Tokenizer
        self.config = config
        self.tokenizer = Tokenizer.from_file("/model/tokenizer.json")
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.url = os.environ["EMB_TEI_URL"]

    def request(self, route, body=None):
        req = Request(self.url + route, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=600) as response:
            return json.load(response)

    def lengths(self, texts):
        return [len(t.ids) for t in self.tokenizer.encode_batch(texts)]

    def encode(self, texts):
        return self.request("/embed", {"inputs": texts, "truncate": False, "normalize": False})

    def info(self):
        info = self.request("/info")
        return {"engine": "tei", "upstream": info, "device": self.config["device"],
                "device_evidence": "Container device assignment and backend startup logs must corroborate TEI device; see attempt evidence.",
                "device_observed": False, "tokenizer": "local tokenizer.json, truncation disabled",
                "versions": {"tokenizers": importlib.metadata.version("tokenizers")}}


class STBackend:
    def __init__(self, config):
        import torch
        from sentence_transformers import SentenceTransformer
        self.config = config
        self.lock = threading.Lock()
        if config["profile"].get("requires_model_adapter") and not config["profile"].get("modules"):
            raise RuntimeError(config["profile"]["requires_model_adapter"])
        device = config["torch_device"]
        if config["device"] == "gpu" and device == "cpu":
            raise RuntimeError("GPU strategy cannot run on CPU")
        if device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("Selected GPU runtime is unavailable; CPU fallback is forbidden")
        self.model = SentenceTransformer("/model", device=device, local_files_only=True, trust_remote_code=False,
                                         model_kwargs={"torch_dtype": getattr(torch, config["dtype"])})
        self.model.max_seq_length = config["context_window"]
        actual = self.model.get_sentence_embedding_dimension()
        if actual != config["native_dimensions"]:
            raise RuntimeError(f"Loaded dimension {actual} != approved native {config['native_dimensions']}")
        self.device = str(self.model.device)
        if (config["device"] == "cpu") != (self.model.device.type == "cpu"):
            raise RuntimeError("Actual model device violates approval")
        # Allocation on the selected model device is observed, not inferred from an env var.
        probe = torch.ones(1, device=self.model.device)
        self.probe_device = str(probe.device)
        self.parameter_devices = sorted({str(p.device) for p in self.model.parameters()})
        if any(p.device.type != self.model.device.type for p in self.model.parameters()):
            raise RuntimeError("Model parameters are spread across unapproved device types")
        self.model.eval()

    def lengths(self, texts):
        tokens = self.model.tokenizer(texts, truncation=False, padding=False, add_special_tokens=True)
        return [len(ids) for ids in tokens["input_ids"]]

    def encode(self, texts):
        # Prompt is already applied centrally. Suppress model default prompt to avoid doubling.
        with self.lock:
            return self.model.encode(texts, prompt="", normalize_embeddings=False, show_progress_bar=False,
                                     convert_to_numpy=True).tolist()

    def info(self):
        return {"engine": "sentence-transformers", "device": "cpu" if self.model.device.type == "cpu" else "gpu",
                "device_observed": True, "model_device": self.device, "probe_device": self.probe_device,
                "parameter_devices": self.parameter_devices, "max_seq_length": self.model.max_seq_length,
                "dtype": str(next(self.model.parameters()).dtype),
                "versions": {p: importlib.metadata.version(p) for p in ("torch", "sentence-transformers", "transformers")}}


def handler(config, backend):
    class Handler(BaseHTTPRequestHandler):
        def respond(self, code, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path not in {"/health", "/info", "/v1/models"}:
                return self.respond(404, {"error": "not found"})
            try:
                observed = backend.info()
                if self.path == "/health":
                    return self.respond(200, {"status": "ok"})
                if self.path == "/v1/models":
                    return self.respond(200, {"object": "list", "data": [{"id": config["model"], "object": "model"}]})
                return self.respond(200, {"model": config["model"], "strategy_id": config["id"], "attempt_id": config["attempt_id"],
                    "context_window": config["context_window"], "dimensions": config["dimensions"],
                    "native_dimensions": config["native_dimensions"], "input_policy": "reject_over_limit",
                    "prompt_policy": config["profile"].get("prompts"), "default_input_type": config["profile"].get("default_input_type"),
                    "backend": observed})
            except Exception as exc:
                logging.exception("Backend health/info failed")
                return self.respond(503, {"error": str(exc)})

        def do_POST(self):
            if self.path not in {"/v1/embeddings", "/tokenize"}:
                return self.respond(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 10_000_000:
                    raise InputError("Request body must be 1..10000000 bytes")
                body = json.loads(self.rfile.read(length))
                texts = inputs_from(body, config)
                lengths = backend.lengths(texts)
                if self.path == "/tokenize":
                    return self.respond(200, {"lengths": lengths, "context_window": config["context_window"], "prompt_included": True})
                check_lengths(lengths, config["context_window"])
                vectors = project(backend.encode(texts), config)
                if len(vectors) != len(texts):
                    raise ValueError("Backend vector count mismatch")
                self.respond(200, {"object": "list", "model": config["model"], "data": [
                    {"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
                    "usage": {"prompt_tokens": sum(lengths), "total_tokens": sum(lengths)}})
            except (InputError, json.JSONDecodeError) as exc:
                self.respond(400, {"error": {"message": str(exc), "type": "invalid_request_error"}})
            except Exception as exc:
                logging.exception("Embedding request failed")
                self.respond(502, {"error": {"message": str(exc), "type": "backend_error"}})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    with open(args.config) as f:
        config = json.load(f)
    backend = TEIBackend(config) if config["engine"] == "tei" else STBackend(config)
    logging.basicConfig(level=logging.INFO)
    print(json.dumps({"event": "runtime_loaded", "model": config["model"], "strategy": config["id"], "engine": config["engine"]}), flush=True)
    ThreadingHTTPServer(("0.0.0.0", args.port), handler(config, backend)).serve_forever()


if __name__ == "__main__":
    main()
