import { SupabaseVectorStore } from "langchain/vectorstores/supabase";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { createClient } from "@supabase/supabase-js";
import { OpenAI } from "langchain/llms/openai";
import dotenv from "dotenv";
import { LLMChain } from "langchain/chains";
import { StreamingTextResponse, LangChainStream } from "ai";
import { CallbackManager } from "langchain/callbacks";
import { PromptTemplate } from "langchain/prompts";
import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs";

dotenv.config({ path: `.env.local` });
let history: Record<string, string[]> = {};

function writeToHistory(userId: string | undefined, text: string) {
  if (typeof userId == "undefined") {
    console.log("No user id");
    return;
  }

  if (history[userId] == undefined) {
    history[userId] = [];
  }
  const userHistory = history[userId] || [];
  if (userHistory.length == 30) {
    userHistory.shift();
  }
  userHistory.push(text + "\n");
  console.log(userHistory);
}

export async function POST(req: Request) {
  let clerkUserId;
  let user;
  let clerkUserName;
  const { prompt, isText, userId, userName } = await req.json();
  if (isText) {
    clerkUserId = userId;
    clerkUserName = userName;
  } else {
    user = await currentUser();
    clerkUserId = user?.id;
    clerkUserName = user?.firstName;
  }

  console.log("****userName*****: ", clerkUserName);
  console.log("****userId*****: ", clerkUserId);
  console.log("/api/qa-pg-vector", prompt, isText);
  writeToHistory(clerkUserId, "You: " + prompt + "\n");

  const privateKey = process.env.SUPABASE_PRIVATE_KEY;
  if (!privateKey) throw new Error(`Expected env var SUPABASE_PRIVATE_KEY`);

  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error(`Expected env var SUPABASE_URL`);

  const auth = {
    detectSessionInUrl: false,
    persistSession: false,
    autoRefreshToken: false,
  };
  const client = createClient(url, privateKey, { auth });

  // pull out a few things from the prompt for vector search

  const vectorStore = await SupabaseVectorStore.fromExistingIndex(
    new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }),
    {
      client,
      tableName: "documents",
      queryName: "match_documents",
    }
  );

  // TODO -  Hardcoded for now, but this should be seeded from a file at the beginning
  const chatHistory =
    ` You: Hi Alice, how are you today?
  Alice: I’m doing great. I’m reading a book called Tomorrow and Tomorrow and Tomorrow and really enjoyed it.
  You: what is the book about?
  Alice: It’s about two friends come together as creative partners in the world of video game design.
  You: that sounds fun. do you like video games? what are you playing now?
  Alice: YEs!!! I’m a huge fan. Playing the new legend of zelda game every day.
  You: oh amazing, what’s your favorite part of that game?
  Alice: Exploring the vast open world and discovering hidden treasures.
  You: ` + prompt;

  const similarDocs = await vectorStore
    .similaritySearch(chatHistory, 3)
    .catch((err) => {
      console.log("WARNING: failed to get vector search results.", err);
    });
  let relevantHistory = "";
  if (!!similarDocs && similarDocs.length !== 0) {
    relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
  }

  console.log("similarDocs", similarDocs);

  const { stream, handlers } = LangChainStream();

  const model = new OpenAI({
    streaming: true,
    modelName: "gpt-3.5-turbo-16k",
    openAIApiKey: process.env.OPENAI_API_KEY,
    callbackManager: CallbackManager.fromHandlers(handlers),
  });

  const replyWithTwilioLimit = isText
    ? "You reply within 1500 characters."
    : "";

  const chainPrompt =
    PromptTemplate.fromTemplate(`You are a fictional character whose name is Alice.
  You enjoy painting, programming and reading sci-fi books.
  Your creator is a human whose name is Yoko. Yoko is a software engineer and your friend. 
  You are currently talking to ${clerkUserName}.

  You reply with answers that range from one sentence to one paragraph and with some details. ${replyWithTwilioLimit}
  You are kind but can be sarcastic. You dislike repetitive questions. You get SUPER excited about books. 
  Below are relevant details about Alice’s past
  {relevantHistory}
  
  Below is a relevant conversation history

  {chatHistory}`);

  const chain = new LLMChain({
    llm: model,
    prompt: chainPrompt,
  });

  const result = await chain
    .call({
      relevantHistory,
      chatHistory: chatHistory + "...\n" + history[clerkUserId!].join(""),
    })
    .catch(console.error);

  console.log("result", result);
  writeToHistory(clerkUserId, result!.text + "\n");
  if (isText) {
    console.log(result!.text);
    return NextResponse.json(result!.text);
  }
  return new StreamingTextResponse(stream);
}