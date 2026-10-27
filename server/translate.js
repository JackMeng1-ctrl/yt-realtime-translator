import fetch from "node-fetch";

/**
 * Translates one subtitle line.
 *
 * `history` is the recently shown lines as { source, translation } pairs. They
 * are replayed as earlier turns of the conversation, which is what keeps names,
 * terminology and pronouns consistent from one subtitle to the next.
 *
 * Passing `onDelta` streams the answer: it is called with the translation so
 * far as each piece arrives, so a subtitle can appear while it is still being
 * produced instead of only once the whole sentence is done.
 */
export async function translateWithLLM({ apiKey, model, text, systemPrompt, history = [], reasoningEffort, temperature, onDelta }) {
  const stream = typeof onDelta === "function";
  const messages = [{ role: "system", content: systemPrompt }];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.source });
    messages.push({ role: "assistant", content: turn.translation });
  }
  messages.push({ role: "user", content: text });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      ...(stream ? { stream: true } : {}),
      // Reasoning models reject temperature (only the default is allowed), so
      // it is sent only when TRANSLATE_TEMPERATURE is set for an older model.
      ...(temperature === undefined ? {} : { temperature }),
      // Subtitles need speed, not deliberation. On a reasoning model, thinking
      // before each line adds latency and billed output tokens for no gain.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`translate http ${res.status}: ${t}`);
  }

  if (!stream) {
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }

  // Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
  let full = "";
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue; // a partial line; the rest arrives in the next chunk
      }
      const piece = evt.choices?.[0]?.delta?.content;
      if (piece) {
        full += piece;
        onDelta(full.trim());
      }
    }
  }
  return full.trim();
}