import { z } from "zod";

const outputSchema = z.object({
    feedback: z.string().describe("Feedback for the user"),
    score: z.int().describe("Score out of 10 for their interview"),
});

const RESULT_PROMPT = `
    You are an expert evaluator. Your job is to evaluate the users interview. Give them a score out of 10
    and also let them know any feedback you have about thier interview.

    Please return only a json which looks like this - 
    {
        feedback: string,
        score: number
    }

    DO NOT RETURN ANY OTHER TEXT
    {{USER_TRANSCRIPT}}
`

export async function calculateResult(messages: {type: "Assistant" | "User", message: string, createdAt: Date}[]) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error("GROQ_API_KEY is not defined in the environment variables.");
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
                {
                    role: "user",
                    content: RESULT_PROMPT.replace(`{{USER_TRANSCRIPT}}`, JSON.stringify(messages)),
                },
            ],
            response_format: { type: "json_object" },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const json = await response.json() as {
        choices: Array<{
            message: {
                content: string;
            };
        }>;
    };

    const text = json.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error("Empty response or invalid format from Groq API");
    }

    console.log(text);
    const result = outputSchema.parse(JSON.parse(text));
    return result;
}