"""Model-specific text paths whose pooling/processing differs from generic ST.

References: official Qwen3-VL-Embedding, Kakao Kanana and Perplexity model cards.
Local custom code is permitted only when all reviewed files match these hashes.
"""
import hashlib
import inspect
import json
from pathlib import Path
from .policy import InputError


PPLX_CODE = {
    "configuration.py": "5751af339bda2520ed98cd64b2037e9c4053ff1758d1a735c59fc2ac4ed66b44",
    "modeling.py": "6f1b6bba6d04ee0b109514ae099a30f5efccf8c726f4b26480ef79b1cb2cf82c",
    "st_quantize.py": "f62a56e8cd30a922cbf3edf3d0c3f9d8037983cc0ca068f16637495cedd60405",
}
PPLX_CONTEXT_CODE = {
    **PPLX_CODE,
    "modeling.py": "082781ac3e0b8bdc993997dac4c97b88d61de6d3279441f7c33be8d79d61f76a",
    "st_quantize.py": "054a5a9a0e5127bbadf0ac4b5987312c82bfa051a43e4d1d8c7d1a15692d31ce",
}


def reviewed_pplx_code(contextual=False, root=Path("/model")):
    expected = PPLX_CONTEXT_CODE if contextual else PPLX_CODE
    for name, sha in expected.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != sha:
            raise RuntimeError(f"Local {name} differs from reviewed model code; review before execution")
    config = json.loads((root / "config.json").read_text())
    expected_map = {"AutoConfig": "configuration.PPLXQwen3Config",
                    "AutoModel": "modeling.PPLXQwen3ContextualModel" if contextual else "modeling.PPLXQwen3Model"}
    if config.get("auto_map") != expected_map:
        raise RuntimeError("Model auto_map refers outside the reviewed code entry points")
    tokenizer = json.loads((root / "tokenizer_config.json").read_text())
    if tokenizer.get("auto_map"):
        raise RuntimeError("Unreviewed custom tokenizer entry points are forbidden")
    if not contextual:
        modules = json.loads((root / "modules.json").read_text())
        allowed = [("sentence_transformers.models.Transformer", ""),
                   ("sentence_transformers.models.Pooling", "1_Pooling"), ("st_quantize.FlexibleQuantizer", "")]
        if [(module.get("type"), module.get("path")) for module in modules] != allowed:
            raise RuntimeError("ST pipeline differs from reviewed model modules")
    return {"source": "reviewed local Perplexity model files; offline-only", "sha256": expected}


def mask_signature_compatibility(original):
    parameters = inspect.signature(original).parameters

    def adapted(**kwargs):
        if "input_embeds" in kwargs and "inputs_embeds" in parameters:
            kwargs["inputs_embeds"] = kwargs.pop("input_embeds")
        if "cache_position" not in parameters:
            kwargs.pop("cache_position", None)
        return original(**kwargs)
    return adapted


def checked_loaded(loaded):
    model, evidence = loaded
    if evidence.get("missing_keys") or evidence.get("mismatched_keys") or evidence.get("error_msgs"):
        raise RuntimeError(f"Embedding adapter did not load all expected checkpoint weights: {evidence}")
    return model, {"missing_keys": [], "mismatched_keys": [], "unexpected_keys": evidence.get("unexpected_keys", [])}


def bounded_batches(lengths, token_budget, max_batch_size=32):
    """Bound padded tokens and retain original indices for response ordering."""
    if not lengths or any(n <= 0 or n > token_budget for n in lengths):
        raise InputError("Native inference input exceeds approved token budget")
    batch = []
    for index in sorted(range(len(lengths)), key=lambda i: lengths[i], reverse=True):
        if batch and (len(batch) >= max_batch_size or (len(batch) + 1) * lengths[batch[0]] > token_budget):
            yield batch
            batch = []
        batch.append(index)
    if batch:
        yield batch


class NativeAdapter:
    def __init__(self, config):
        self.config = config
        self.max_seq_length = config["context_window"]

    @property
    def device(self):
        return next(self.model.parameters()).device

    def parameters(self):
        return self.model.parameters()

    def eval(self):
        self.model.eval()

    def get_sentence_embedding_dimension(self):
        cfg = getattr(self.model.config, "text_config", self.model.config)
        return cfg.hidden_size

    def lengths(self, texts):
        return [len(ids) for ids in self.tokenizer(texts, truncation=False, padding=False)["input_ids"]]

    def encode(self, texts, **kwargs):
        import numpy as np
        rows = [None] * len(texts)
        for indices in bounded_batches(self.lengths(texts), self.max_seq_length):
            vectors = self._encode_batch([texts[i] for i in indices])
            if len(vectors) != len(indices):
                raise RuntimeError("Native inference batch returned the wrong vector count")
            for index, vector in zip(indices, vectors):
                rows[index] = vector
        return np.stack(rows)


class QwenVLTextAdapter(NativeAdapter):
    def __init__(self, config):
        super().__init__(config)
        import torch
        from transformers import AutoProcessor, Qwen3VLModel
        self.model, loading = checked_loaded(Qwen3VLModel.from_pretrained(
            "/model", local_files_only=True, dtype=getattr(torch, config["dtype"]),
            attn_implementation="sdpa", output_loading_info=True))
        self.model.to(config["torch_device"])
        self.processor = AutoProcessor.from_pretrained("/model", local_files_only=True, padding_side="right")
        self.tokenizer = self.processor.tokenizer
        self.adapter_info = {"name": "Qwen3-VL text processor + last-token pooling",
                             "loader": "transformers.Qwen3VLModel; no local custom-code execution",
                             "instruction": "Represent the user's input.", "modalities_tested": ["text"], "weight_loading": loading}

    def formatted(self, texts):
        return self.processor.apply_chat_template([
            [{"role": "system", "content": [{"type": "text", "text": "Represent the user's input."}]},
             {"role": "user", "content": [{"type": "text", "text": text}]}] for text in texts],
            add_generation_prompt=True, tokenize=False)

    def lengths(self, texts):
        return super().lengths(self.formatted(texts))

    def _encode_batch(self, texts):
        import torch
        batch = self.processor(text=self.formatted(texts), truncation=False, padding=True,
                               return_tensors="pt")
        batch = {key: value.to(self.device) for key, value in batch.items()}
        with torch.inference_mode():
            hidden = self.model(**batch, use_cache=False).last_hidden_state
            last = batch["attention_mask"].shape[1] - batch["attention_mask"].flip(1).argmax(1) - 1
            vectors = hidden[torch.arange(hidden.shape[0], device=self.device), last]
        return vectors.float().cpu().numpy()


class KananaTextAdapter(NativeAdapter):
    def __init__(self, config):
        super().__init__(config)
        import torch
        from transformers import AutoTokenizer, LlamaConfig, LlamaModel
        native_config = LlamaConfig.from_pretrained("/model", local_files_only=True)
        self.model, loading = checked_loaded(LlamaModel.from_pretrained(
            "/model", config=native_config, local_files_only=True,
            dtype=getattr(torch, config["dtype"]), attn_implementation="sdpa", output_loading_info=True))
        self.model.to(config["torch_device"])
        for layer in self.model.layers:
            layer.self_attn.is_causal = False
        self.tokenizer = AutoTokenizer.from_pretrained("/model", local_files_only=True)
        self.tokenizer.pad_token = self.tokenizer.eos_token
        self.adapter_info = {"name": "Kanana bidirectional Llama + mean pooling",
                             "loader": "transformers.LlamaModel; no local custom-code execution",
                             "instruction": "empty (official encode default)", "causal_attention": False, "weight_loading": loading}

    def lengths(self, texts):
        return super().lengths([text.strip() for text in texts])

    def _encode_batch(self, texts):
        import torch
        inputs = self.tokenizer([text.strip() for text in texts], padding=True, truncation=False,
                                return_tensors="pt", return_token_type_ids=False)
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        valid = inputs["attention_mask"]
        size = valid.shape[1]
        # Official Kanana's BiLlama uses a non-causal 4D padding mask.
        mask = torch.zeros((len(texts), 1, size, size), device=self.device, dtype=next(self.model.parameters()).dtype)
        mask.masked_fill_(~valid[:, None, None, :].bool(), torch.finfo(mask.dtype).min)
        with torch.inference_mode():
            hidden = self.model(input_ids=inputs["input_ids"], attention_mask=mask, use_cache=False).last_hidden_state
            vectors = (hidden * valid.unsqueeze(-1).float()).sum(1) / valid.sum(1, keepdim=True)
        return vectors.float().cpu().numpy()


class PPLXContextAdapter(NativeAdapter):
    def __init__(self, config):
        super().__init__(config)
        review = reviewed_pplx_code(contextual=True)
        import torch
        from transformers import AutoModel
        self.model, loading = checked_loaded(AutoModel.from_pretrained(
            "/model", trust_remote_code=True, local_files_only=True,
            dtype=getattr(torch, config["dtype"]), attn_implementation="sdpa", output_loading_info=True))
        self.model.to(config["torch_device"])
        import sys
        implementation = sys.modules[type(self.model).__module__]
        implementation.create_causal_mask = mask_signature_compatibility(implementation.create_causal_mask)
        self.tokenizer = self.model.tokenizer
        self.adapter_info = {"name": "Perplexity contextual late chunking", "contextual": True,
                             "flat_input": "each string is a separate one-chunk document",
                             "nested_endpoint": "/v1/contextualizedembeddings", "code_review": review,
                             "mask_api_compatibility": "adapt reviewed code to installed transformers mask signature",
                             "weight_loading": loading,
                             "reserved_separator": self.tokenizer.sep_token,
                             "quantization": "official unnormalized int8, represented as JSON floats"}

    def encode(self, texts, **kwargs):
        import numpy as np
        return np.stack([rows[0] for rows in self.encode_documents([[text] for text in texts])])

    def encode_documents(self, documents):
        self.check_chunks(documents)
        rows = self.model.encode(documents, batch_size=1, normalize_embeddings=False,
                                 convert_to_numpy=False, quantization="int8", device=self.device)
        if len(rows) != len(documents) or any(len(row) != len(doc) for row, doc in zip(rows, documents)):
            raise RuntimeError("Official contextual encoder changed supplied document/chunk boundaries")
        return [row.float().cpu().numpy() for row in rows]

    def check_chunks(self, documents):
        separator = self.tokenizer.sep_token
        if not separator:
            raise RuntimeError("Contextual tokenizer has no document chunk separator")
        if any(separator in text for chunks in documents for text in chunks):
            raise InputError("Reserved context separator cannot appear literally inside a text chunk")

    def lengths(self, texts):
        self.check_chunks([[text] for text in texts])
        return super().lengths(texts)

    def document_lengths(self, documents):
        self.check_chunks(documents)
        return super().lengths([self.tokenizer.sep_token.join(chunks) for chunks in documents])


def native_adapter(config):
    kind = config["profile"].get("model_type")
    if kind == "qwen3_vl":
        return QwenVLTextAdapter(config)
    if kind == "kanana2vec":
        return KananaTextAdapter(config)
    if kind == "bidirectional_pplx_qwen3":
        metadata = json.loads(Path("/model/config.json").read_text())
        if metadata.get("auto_map", {}).get("AutoModel") == "modeling.PPLXQwen3ContextualModel":
            return PPLXContextAdapter(config)
    return None
