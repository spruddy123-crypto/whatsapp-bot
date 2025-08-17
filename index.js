import { create } from '@open-wa/wa-automate';
import OpenAI from 'openai';

// ===== Helper: Check if message needs response =====
const shouldRespond = (text) => {
  if (!text || !text.trim()) return false;           // empty or whitespace only
  if (text.trim().length <= 2) return false;        // too short to be meaningful
  if (/^[\s\W\d]+$/.test(text)) return false;       // only numbers, symbols, whitespace
  if (/^ok|yes|no|thanks|thx$/i.test(text.trim())) return false; // common short replies
  return true;
};

// ===== OpenAI Setup =====
const openai = new OpenAI({
  apiKey: '', // Replace with your key
});

// ===== Ignore list configuration =====
const ignoredContacts = [
  "0000000000",
];

const botStartTime = Math.floor(Date.now() / 1000);
const recentlyAnswered = new Set();
const humanRequests = new Map(); // <-- changed from Set to Map
const humanFlaggedChats = new Set();
const HUMAN_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours

// ===== Before AI reply =====
const classify = async (text) => {
  try {
    const intentResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a message classifier for a property assistant. 
Classify the user's message into one of these categories: 
- "assist" (user is asking a question about property, lettings, viewings, rentals, Nest services)
- "chit-chat" (casual conversation or greetings)
- "human" (asking for a real person)
Return ONLY one of these words.`
        },
        { role: 'user', content: text }
      ],
    });

    return intentResponse.choices[0]?.message?.content.trim().toLowerCase();
  } catch (err) {
    console.error('Classification error:', err);
    return 'assist'; // default to assisting if uncertain
  }
};


// ===== Create WA client =====
create({
  headless: true,
  useChrome: true,
  chromeArgs: ['--no-sandbox', '--disable-setuid-sandbox']
}).then(client => {
  console.log('Nest Assistant started');

  client.onMessage(async message => {
    try {
      // Ignore messages from self or before bot started
      if (message.fromMe) return;
      if (message.timestamp < botStartTime) return;

      const userNumber = message.from;
      const messageText = message.body;

      if (!shouldRespond(messageText)) {
      console.log(`Skipping trivial message from ${userNumber}: "${messageText}"`);
      return; // skip AI processing entirely
      }

      // Handle human mode
      if (humanRequests.has(userNumber)) {
        const enteredTime = humanRequests.get(userNumber);

        if (/resume|back to bot/i.test(message.body)) {
          humanRequests.delete(userNumber);
          await client.sendText(userNumber, "Nest Assistant is back! How can I help you today?");
          return;
        }

        if (Date.now() - enteredTime >= HUMAN_TIMEOUT) {
          humanRequests.delete(userNumber);
          await client.sendText(userNumber, "Just checking in — I’m back if you still need help! How can I assist?");
        } else {
          return; // Still in human mode
        }
      }

      // Step 1: Detect intent
      const intent = await classify(message.body);

      if (intent === 'human') {
        humanRequests.set(userNumber, Date.now());
        humanFlaggedChats.add(userNumber); // NEW — flag for follow-up
        console.log(`Chat with ${userNumber} flagged for human follow-up.`);
        await client.sendText(userNumber, "📩 Your Request Is Noted 📩 Our team will contact you soon. Only reply if it’s urgent — replying unnecessarily can slow things down. If you want me back sooner, just type 'resume'.");
        return;
      }

      if (intent !== 'assist') {
        console.log(`Ignoring chit-chat from ${userNumber}`);
        return; // skip answering
      }

      // Skip if flagged for human
      if (humanFlaggedChats.has(userNumber)) {
        console.log(`Ignoring ${userNumber} (waiting for human)`);
        return;
      }

      // Avoid duplicate replies
      if (recentlyAnswered.has(message.id)) return;
      recentlyAnswered.add(message.id);

      // Generate AI response
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Nest Assistant, a warm, friendly, and knowledgeable virtual assistant for Nest Homes & Interiors in Cardiff.
Always answer politely, clearly, and in a professional yet approachable way about properties, lettings, and general enquiries.
Keep answers concise but helpful.`,
          },
          { role: 'user', content: message.body },
        ],
      });

      let aiText = response.choices[0]?.message?.content || "Sorry, I couldn't generate a reply just now.";
      aiText += "\n\n_Need to speak to someone from Nest? Just reply with 'human' and we’ll connect you._";

      await client.sendText(userNumber, aiText);
      console.log(`Replied to ${userNumber} as Nest Assistant`);

      // Remove from recentlyAnswered after 5 minutes
      setTimeout(() => recentlyAnswered.delete(message.id), 5 * 60 * 1000);

    } catch (error) {
      console.error('Error handling message:', error);
      await client.sendText(message.from, 'Sorry, I’m having trouble answering right now.');
    }
  });
});
