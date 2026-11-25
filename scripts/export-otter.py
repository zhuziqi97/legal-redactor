"""Export the pinned Otter cross-encoder's span scores for desktop inference."""

import argparse
import os
from pathlib import Path

import torch
from torch import nn
from transformers import AutoModel


class SpanScorer(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.radius = model.token_encoder.config.sliding_window

    def forward(self, input_ids, attention_mask, label_indices, span_indices, span_lengths):
        model = self.model
        positions = torch.arange(input_ids.size(1), device=input_ids.device)
        nearby = (positions[:, None] - positions[None, :]).abs() <= self.radius
        valid = attention_mask[:, None, None, :].bool()
        blocked = torch.full((), torch.finfo(torch.float32).min, device=input_ids.device)
        masks = {"full_attention": torch.where(valid, 0., blocked),
                 "sliding_attention": torch.where(valid & nearby, 0., blocked)}
        hidden = model.token_encoder(input_ids=input_ids, attention_mask=masks).last_hidden_state
        normalize = torch.nn.functional.normalize
        starts = normalize(model.token_start_linear(hidden), dim=-1)
        ends = normalize(model.token_end_linear(hidden), dim=-1)
        labels = normalize(model.type_linear(hidden[:, label_indices]), dim=-1)
        spans = torch.cat((model.gather_spans(starts, span_indices[:, :, 0]),
                           model.gather_spans(ends, span_indices[:, :, 1]),
                           model.width_embedding(span_lengths)), dim=2)
        spans = normalize(model.token_span_linear(spans), dim=-1)
        return model.span_logit_scale.exp() * torch.matmul(labels, spans.transpose(1, 2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    torch.set_num_threads(4)
    model = AutoModel.from_pretrained(args.model_dir.resolve(), local_files_only=True,
                                      trust_remote_code=True, use_safetensors=True).eval()
    model.token_encoder.config._attn_implementation = "eager"
    scorer = SpanScorer(model).eval()
    tokens = model.tokenizer(["[LABEL] person [SEP] 张甲签字。"], return_tensors="pt")
    token_ids = tokens["input_ids"]
    label_index = torch.nonzero(token_ids[0] == model.tokenizer.convert_tokens_to_ids("[LABEL]")).flatten()
    inputs = token_ids, tokens["attention_mask"], label_index, torch.tensor([[[5, 6], [6, 6]]]), torch.tensor([[2, 1]])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        torch.onnx.export(scorer, inputs, args.output, dynamo=False, opset_version=18,
                          input_names=["input_ids", "attention_mask", "label_indices", "span_indices", "span_lengths"],
                          output_names=["logits"], dynamic_axes={"input_ids": {0: "batch", 1: "tokens"},
                            "attention_mask": {0: "batch", 1: "tokens"}, "label_indices": {0: "labels"},
                            "span_indices": {0: "batch", 1: "spans"}, "span_lengths": {0: "batch", 1: "spans"},
                            "logits": {0: "batch", 1: "labels", 2: "spans"}})


if __name__ == "__main__":
    main()
