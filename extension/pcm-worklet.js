class Pcm16Processor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input[1] || left;

    const length = left.length;
    const pcm16 = new Int16Array(length);

    for (let i = 0; i < length; i++) {
      const sample = (left[i] + right[i]) / 2;

      let s = Math.max(-1, Math.min(1, sample));
      pcm16[i] = s < 0
        ? Math.round(s * 0x8000)
        : Math.round(s * 0x7fff);
    }

    // passthrough
    if (output && output[0]) output[0].set(left);
    if (output && output[1]) output[1].set(right);

    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);

    return true;
  }
}

registerProcessor("pcm16-processor", Pcm16Processor);