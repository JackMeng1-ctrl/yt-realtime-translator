import fetch from "node-fetch";

export async function translateWithLLM({ apiKey, model, text, systemPrompt }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`translate http ${res.status}: ${t}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}