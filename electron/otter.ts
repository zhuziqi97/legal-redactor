const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
const { Tokenizer } = require('tokenizers') as typeof import('tokenizers');
const { readFileSync } = require('node:fs') as typeof import('node:fs');
const { availableParallelism } = require('node:os') as typeof import('node:os');
const { join } = require('node:path') as typeof import('node:path');

type InferenceDevice = import('../engine/inference-devices.js').InferenceDevice;
type TokenSpan = [start: number, end: number];
type Prediction = { start: number; end: number; label: string; score: number };

// 6 GiB discrete cards report ~5.8 GiB in DXGI DedicatedVideoMemory after driver reservation.
const MIN_DML_BUCKET_VRAM_MIB = 5632;
const DML_TOKEN_BUCKETS = [128, 192, 256] as const;

// Cap at 8 threads to fit within P-cores / one CCD and avoid E-core barrier stalls on hybrid CPUs.
function cpuThreadCount(parallelism = availableParallelism()) {
  const cores = Math.max(1, Math.floor(parallelism));
  return Math.min(cores, Math.max(4, Math.min(8, Math.floor(cores / 2))));
}

// Keep DirectML locked to a few compiled shapes on 6 GiB+ discrete GPUs without hurting weak GPUs, CPU, or WebGPU.
function batchShape(device: Pick<InferenceDevice, 'backend' | 'memoryMiB'>, rawTokens: number, rawBatch: number) {
  if (device.backend !== 'dml' || (device.memoryMiB ?? 0) < MIN_DML_BUCKET_VRAM_MIB || rawTokens > 256) {
    return { tokenCount: rawTokens, batchSize: rawBatch };
  }
  const tokenCount = DML_TOKEN_BUCKETS.find(bucket => rawTokens <= bucket) ?? rawTokens;
  return { tokenCount, batchSize: rawBatch > 1 && rawBatch < 8 ? 8 : rawBatch };
}

class NativeOtter {
  readonly tokenizer: ReturnType<typeof Tokenizer.fromFile>;
  readonly maxSpan: number;
  private readonly marker: number;
  private readonly padding: number;

  constructor(directory: string, private readonly session: import('onnxruntime-node').InferenceSession,
    private readonly device: InferenceDevice) {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    this.tokenizer = Tokenizer.fromFile(join(directory, 'tokenizer.json'));
    this.tokenizer.setTruncation(config.max_seq_length);
    this.maxSpan = config.max_span_length;
    this.marker = this.tokenizer.tokenToId('[LABEL]') ?? -1;
    this.padding = this.tokenizer.tokenToId('<pad>') ?? 0;
  }

  static async load(directory: string, device: InferenceDevice) {
    const options: import('onnxruntime-node').InferenceSession.SessionOptions = {
      intraOpNumThreads: device.backend === 'cpu' ? cpuThreadCount() : 4,
      interOpNumThreads: 1,
    };
    options.executionProviders = [device.index === undefined ? device.backend : { name: device.backend, deviceId: device.index }];
    if (device.backend === 'dml') {
      options.enableMemPattern = false;
      options.executionMode = 'sequential';
    }
    const session = await ort.InferenceSession.create(join(directory, 'otter.onnx'), options);
    return new NativeOtter(directory, session, device);
  }

  release() { return this.session.release(); }

  async predict(texts: string[], labels: string[]): Promise<Prediction[][]> {
    const prompt = `[LABEL] ${labels.join(' [LABEL] ')} [SEP] `;
    const encoded = await this.tokenizer.encodeBatch(texts.map(text => prompt + text));
    const ids = encoded.map(row => row.getIds());
    const offsets = encoded.map(row => row.getOffsets());
    const sequenceIds = encoded.map(row => row.getSequenceIds());
    const rawTokenCount = Math.max(...ids.map(row => row.length));
    const labelIndices = ids[0].flatMap((id, index) => id === this.marker && offsets[0][index][0] < prompt.length ? [index] : []);
    if (labelIndices.length !== labels.length) throw new Error('Otter 标签分词与模型配置不一致。');
    const textStart = Math.min(...offsets.map(row => row.findIndex(([, end]) => end > prompt.length)).filter(index => index !== -1));
    if (!Number.isFinite(textStart)) return texts.map(() => []);
    const { tokenCount, batchSize: count } = batchShape(this.device, rawTokenCount, texts.length);
    const spans: TokenSpan[] = [];
    for (let start = textStart; start < tokenCount; start++) {
      for (let end = start; end < Math.min(start + this.maxSpan, tokenCount); end++) spans.push([start, end]);
    }
    const length = spans.length;
    const input = new BigInt64Array(count * tokenCount).fill(BigInt(this.padding));
    const attention = new BigInt64Array(input.length);
    const indices = new BigInt64Array(count * length * 2);
    const widths = new BigInt64Array(count * length);
    for (let batch = 0; batch < count; batch++) {
      const source = batch < texts.length ? batch : 0;
      input.set(BigInt64Array.from(ids[source], BigInt), batch * tokenCount);
      attention.fill(1n, batch * tokenCount, batch * tokenCount + ids[source].length);
      for (let position = 0; position < length; position++) {
        const [start, end] = spans[position];
        const offset = batch * length + position;
        indices[offset * 2] = BigInt(start);
        indices[offset * 2 + 1] = BigInt(end);
        widths[offset] = BigInt(end - start + 1);
      }
    }
    const tensor = (data: BigInt64Array, dimensions: number[]) => new ort.Tensor('int64', data, dimensions);
    const { logits } = await this.session.run({
      input_ids: tensor(input, [count, tokenCount]), attention_mask: tensor(attention, [count, tokenCount]),
      label_indices: tensor(BigInt64Array.from(labelIndices, BigInt), [labels.length]),
      span_indices: tensor(indices, [count, length, 2]), span_lengths: tensor(widths, [count, length]),
    });
    const scores = logits.data as Float32Array;
    const cutoff = Math.log(0.3 / 0.7);
    return texts.map((text, batch) => {
      const candidates: { position: number; label: number; score: number }[] = [];
      const seq = sequenceIds[batch];
      for (let label = 0; label < labels.length; label++) {
        for (let position = 0; position < length; position++) {
          const [start, end] = spans[position];
          const score = scores[(batch * labels.length + label) * length + position];
          if (score > cutoff && seq[start] != null && seq[end] != null) candidates.push({ position, label, score });
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      const used = new Uint8Array(tokenCount);
      const chars = Array.from(text);
      const entities: Prediction[] = [];
      for (const candidate of candidates) {
        const [start, end] = spans[candidate.position];
        if (used.subarray(start, end + 1).some(Boolean)) continue;
        used.fill(1, start, end + 1);
        let from = Math.max(0, offsets[batch][start][0] - prompt.length);
        let to = offsets[batch][end][1] - prompt.length;
        while (from < to && /\s/u.test(chars[from])) from++;
        while (to > from && /\s/u.test(chars[to - 1])) to--;
        if (from < to) entities.push({ start: from, end: to, label: labels[candidate.label], score: 1 / (1 + Math.exp(-candidate.score)) });
      }
      return entities.sort((left, right) => left.start - right.start || left.end - right.end);
    });
  }
}

export = { NativeOtter, cpuThreadCount, batchShape };
