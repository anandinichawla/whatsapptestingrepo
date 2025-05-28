/**
 * WhatsApp Task Management Bot
 * 
 * A WhatsApp bot for task management, meeting scheduling, and reminders
 * using Twilio, OpenAI, Supabase, and Google Calendar.
 */

// ============================================================================
// IMPORTS AND CONFIGURATION
// ============================================================================

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const cors = require("cors");
const cron = require("node-cron");
const { default: axios } = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const moment = require("moment-timezone");
const { google } = require("googleapis");
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const chrono = require("chrono-node");
const tinyurl = require("tinyurl");

// Local imports
const supabase = require("./supabaseClient");
const { start } = require("repl");
require("dotenv").config();

// ============================================================================
// APP INITIALIZATION AND MIDDLEWARE
// ============================================================================

const app = express();
const port = process.env.PORT || 8000;

// Configure middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cors());

// ============================================================================
// API CLIENTS INITIALIZATION
// ============================================================================

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Twilio client
const client = new twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize Google OAuth client
const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// global variables 

const shortenUrl = async (longUrl) => {
  const shortURL = tinyurl.shorten(longUrl);
  console.log("shortURL", shortURL);
  return shortURL;
};

let allData = [];
let userSessions = {};
let assignerMap = [];
let todayDate = "";
let currentTime = "";
let isCronRunning = false; // Track if the cron job is active
const sessions = {};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get formatted date in "Month Day, Year" format
 * @returns {string} Formatted date
 */
const getFormattedDate = () => {
  const today = new Date();
  const options = { year: "numeric", month: "long", day: "numeric" };
  console.log(today.toLocaleDateString("en-US", options));
  return today.toLocaleDateString("en-US", options);
};

/**
 * Get formatted time in "h:mm AM/PM" format for IST timezone
 * @returns {string} Formatted time
 */
const getFormattedTime = () => {
  const now = moment().tz("Asia/Kolkata");
  return now.format("h:mm A");
};
const getCurrentDate = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  console.log(`${year}-${month}-${day} ${hours}:${minutes}`);

  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

async function getRefreshToken(userNumber) {
  const { data } = await supabase
    .from("user_tokens")
    .select("refresh_token")
    .eq("phone_number", userNumber)
    .single();
  return data?.refresh_token || null;
}

/**
 * Send WhatsApp message using Twilio
 * @param {string} to - Recipient phone number
 * @param {string} message - Message content
 */
function sendMessage(to, message) {
  console.log("Sending message to:", to);
  console.log("Message:", message);
  client.messages
    .create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body: message,
    })
    .then((message) => {
      console.log("Message sent successfully:", message.sid);
    })
    .catch((err) => {
      console.error("Error sending message:", err);
      if (err.code) {
        console.error("Twilio error code:", err.code);
      }
    });
}

/**
 * Get OAuth client for a specific user
 * @param {string} refreshToken - User's refresh token
 * @returns {OAuth2Client} Configured OAuth client
 */
function getOAuthClient(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

// ===== Utility Function =====


function isValidClockTime(date, startTime) {


  console.log("I am valid clock time function");
  console.log("startTime in valid function", startTime);
  if (!startTime || !date) return false;

  const cleaned = startTime
  .trim()
  .replace(/^['"]+|['"]+$/g, '')  // remove leading/trailing single/double quotes
  .replace(/\u00A0/g, ' ')        // replace non-breaking spaces
  .replace(/\s+/g, ' ');          // collapse extra spaces

  const validFormat = /^\d{1,2}(?:\s*:\s*\d{2})?\s*(a\s*m|am|p\s*m|pm)$/i;

  console.log(`'${cleaned}' →`, validFormat.test(cleaned));  

  const durationPattern = /\b\d+\s*(min|mins|minutes|hour|hours|hr|hrs|half\s*hour|quarter\s*hour)\b/i;
  if (durationPattern.test(startTime)) {
    console.log("I am in duration pattern if statement");
    return false;

  } 

  const fuzzyWords = ["later", "someday", "evening", "morning", "ish"];
  if (fuzzyWords.some(w => startTime.toLowerCase().includes(w))) return false;

  const chronoParsed = chrono.parseDate(`${date} ${startTime}`, new Date(), { forwardDate: true });

  console.log("printing chrono parsed date", chronoParsed); 
  

  if (!chronoParsed) return false;

  // Check if parsed time is a vague relative time (e.g., "10 mins from now")
  const diffInMinutes = (chronoParsed - new Date()) / (1000 * 60);
  console.log("printing diff mins", diffInMinutes);
  if (diffInMinutes > 0 && diffInMinutes < 180) {
    console.log("I am in diff in minutes if statement");
    return false;
  }
  

  console.log("printing true");
  return true;
} // end of is valid clock time function

function isValidDuration(durationText) {
  if (!durationText) return false;

  // Check for valid numeric durations like "30", "45", "60"
  const simpleNumeric = /^\d+$/;
  if (simpleNumeric.test(durationText.trim())) return true;

  // Allow conversational forms like "30 mins", "1 hour", etc.
  const durationPattern = /^\d+\s*(min|mins|minutes|hour|hours|hr|hrs)$/i;
  return durationPattern.test(durationText.trim());
}

async function parseAndValidateClockTime(userMessage, date, args, userNumber, res) {
  const validFormat = /^\d{1,2}(:\d{2})?\s*(am|pm)$/i;
  const durationPattern = /\b\d+\s*(min|mins|minutes|hour|hours|hr|hrs|half\s*hour|quarter\s*hour)\b/i;
  const fuzzyWords = ["later", "someday", "evening", "morning", "ish", "soon"];

  // ❌ 1. Filter clearly invalid or vague phrases
  if (
    !userMessage ||
    fuzzyWords.some(w => userMessage.toLowerCase().includes(w)) ||
    durationPattern.test(userMessage) ||
    !validFormat.test(userMessage.trim())
  ) {
    sessions[userNumber] = {
      awaitingStartTime: true,
      pendingArgs: args,
    };

    const twiml = new MessagingResponse();
    twiml.message("⏰ I couldn’t understand the meeting time. Please reply with a specific time like *10:00 AM* or *3:30 PM*.");
    res.type("text/xml").send(twiml.toString());
    return false;
  }

  // ⏱ 2. GPT disambiguation for weird inputs like "30pm"
  const gptDisambiguation = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content:
          "You are an assistant verifying if a time string is a valid clock time like '10:00 AM', '3 PM', etc.\n" +
          "- If it's valid, return the cleaned-up time like '3:00 PM'.\n" +
          "- If it's confusing or not a valid time, return: unclear.",
      },
      {
        role: "user",
        content: userMessage
      }
    ]
  });

  const reply = gptDisambiguation.choices?.[0]?.message?.content?.trim();
  console.log("GPT reply for start time classification:", reply);

  if (!reply || reply.toLowerCase() === "unclear") {
    sessions[userNumber] = {
      awaitingStartTime: true,
      pendingArgs: args,
    };

    const twiml = new MessagingResponse();
    twiml.message("⏰ I couldn’t understand the time you gave. Please reply with a valid time like *10:00 AM*.");
    res.type("text/xml").send(twiml.toString());
    return false;
  }

  args.startTime = reply; // ✅ Use corrected format like "10:00 AM"
  return true;
}



// ============================================================================
// SUPABASE DATA FUNCTIONS
// ============================================================================

/**
 * Get all tasks from Supabase
 * @returns {Promise<Array>} Array of tasks
 */
async function getAllTasks() {
  const { data, error } = await supabase.from("grouped_tasks").select("*");
  if (error) throw error;

  return data;
}

/**
 * Get refresh token for a user
 * @param {string} userNumber - User's phone number
 * @returns {Promise<string|null>} Refresh token or null
 */
async function getRefreshToken(userNumber) {
  const { data } = await supabase
    .from("user_tokens")
    .select("refresh_token")
    .eq("phone_number", userNumber)
    .single();
  return data?.refresh_token || null;
}

/**
 * Save refresh token for a user
 * @param {string} userNumber - User's phone number
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<boolean>} Success status
 */
async function saveRefreshToken(userNumber, refreshToken) {
  const { error } = await supabase
    .from("user_tokens")
    .upsert({ phone_number: userNumber, refresh_token: refreshToken });
  return !error;
}

// ============================================================================
// TASK MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * Handle user input for task management
 * @param {string} userMessage - User's message
 * @param {string} From - User's phone number
 */
async function main() {
  allData = await getAllTasks();
}

main();

app.get("/refresh", async (req, res) => {
  console.log("Refreshing tasks from Supabase...");
  const { data, error } = await supabase.from("grouped_tasks").select("*");
  if (error) {
    console.error("Error refreshing tasks:", error);
    return res.status(500).json({ message: "Error fetching tasks" });
  }
  allData = data;
  res
    .status(200)
    .json({ message: "Tasks refreshed successfully", tasks: allData });
});

async function handleUserInput(userMessage, From) {
  console.log("we are here===> 1");
  const session = userSessions[From];
  const conversationHistory = session.conversationHistory || [];
  conversationHistory.push({ role: "user", content: userMessage });
  console.log("we are here===> 2");

  assignerMap.push(From);

        console.log('assigner Map===> 0', assignerMap);


  if (session.step === 5) {
    if (userMessage.toLowerCase() === "yes") {
      const taskId = session.taskId; // Now using taskId instead of task name
      const assignee = session.assignee;

      const { data, error } = await supabase
        .from("grouped_tasks")
        .select("tasks")
        .eq("name", assignee)
        .single();

      if (error) {
        console.error("Error fetching tasks:", error);
        sendMessage(From, "Sorry, there was an error accessing the task.");
        return;
      }

      const updatedTasks = data.tasks.map((task) =>
        task.taskId === taskId ? { ...task, task_done: "Completed" } : task
      );

      console.log("updatedTasks --->", updatedTasks);

      const { error: updateError } = await supabase
        .from("grouped_tasks")
        .update({ tasks: updatedTasks })
        .eq("name", assignee);

              console.log('assigner Map===> 1', assignerMap);

      if (updateError) {
        console.error("Error updating task:", updateError);
        sendMessage(
          From,
          "Sorry, there was an error marking the task as completed."
        );
      } else {
        sendMessage(
          From,
          "Thank you! The task has been marked as completed! ✅"
        );
        sendMessage(
          assignerMap[0],
          `The task with ID ${taskId} was completed. ✅`
        );

        cronJobs.get(taskId)?.stop();
        cronJobs.delete(taskId);
      }

      delete userSessions[From];
    } else if (userMessage.toLowerCase() === "no") {
      sendMessage(
        From,
        "⚠️ Why has the task not been completed? Please provide a reason."
      );

      session.step = 6;
    } else {
      sendMessage(From, "Please respond with 'Yes' or 'No'.");
    }
  } else if (session.step === 6) {
    console.log("session --- >", session);

    const reason = userMessage.trim();
    const task = session.task;
    const assignee = session.assignee;
    const taskId = session.taskId;

    console.log("assignee----session====>", assignee);

    const { data, error } = await supabase
      .from("grouped_tasks")
      .select("tasks")
      .eq("name", assignee)
      .single();

    if (error) {
      console.error("Error fetching tasks:", error);
      sendMessage(From, "Sorry, there was an error accessing the task.");
      return;
    }

    const updatedTasks = data.tasks.map((task) =>
      task.taskId === taskId
        ? { ...task, task_done: "Not Completed", reason }
        : task
    );

    console.log("updatedTasks --->", updatedTasks);

    const { error: updateError } = await supabase
      .from("grouped_tasks")
      .update({ tasks: updatedTasks })
      .eq("name", assignee);

      console.log('assigner Map===> 2', assignerMap);
      

    if (updateError) {
      console.error("Error updating task with reason:", updateError);
      sendMessage(From, "Sorry, there was an error saving the reason. ⚠️");
    } else {
      sendMessage(From, "📤 Your response has been sent to the assigner.");
      sendMessage(
        assignerMap[0],
        `⚠️ *Task Not Completed*\n\nThe task with ID ${taskId} was not completed.\n📝 *Reason:* ${reason.trim()}`
      );
    }

    delete userSessions[From];
  } else {
    const prompt = `
You are a helpful task manager assistant. Respond with a formal tone and
a step-by-step format.
Your goal is to guide the user through task assignment:
- Ask for task details (task, assignee, due date, time, and reminder preference).
- The reminder preference can be either:
  - A recurring reminder (e.g., "every 3 mins", "every 2 hours", "every 1 day").
  - A one-time reminder (e.g., "one-time on 20th May at 5PM").
- For one-time reminders, explicitly ask for the reminder date and time (e.g., "When would you like the one-time reminder to be sent? For example, '20th May at 5PM'.").  
- Respond to yes/no inputs appropriately.
- Follow up if any information is incomplete.
- Keep the respone concise and structured.
- Once you have all the details please **summarize** the entered details

EXAMPLES: 

- If a user is asked about due date, due time, and reminder preference, and they send only due date and due time, ask for reminder preference.
- If a user is asked about due date, due time and reminder frequncy, and user sends only due date and due time then it should again ask for reminder frequency and should not ignore that.
- If a user selects a one-time reminder but doesn't provide a reminder date and time, ask for the reminder date and time explicitly.
- Similarly if a user is asked about task, assignee and due date but user only only task and due date then it should again ask the user asking about the assignee since they did not sent that.

IMPORTANT:
- Once all details are collected, return **ONLY** with a JSON object which will be used for backend purpose.
- Do **not** include any extra text before or after the JSON.
- This is only for backend procesing so do **NOT** send this JSON
format to user
- The JSON format should be:
{
"task": "<task_name>",
"assignee": "<assignee_name>",
"dueDate": "<YYYY-MM-DD>",
"dueTime": "<HH:mm>",
"reminder_type": "<recurring|one-time>",
"reminder_frequency": "<reminder_frequency or null for one-time>",
"reminderDateTime": "<YYYY-MM-DD HH:mm or null for recurring>"
}
- For one-time reminders, set reminder_type to "one-time", reminder_frequency to null, and reminderDateTime to the user-specified reminder date and time in "YYYY-MM-DD HH:mm" format.
- For recurring reminders, set reminderDateTime to null.
- Do **not** assume the reminder time is tied to the due date for one-time reminders; it should be based on user input (e.g., "20th May at 5PM").

After having all the details you can send the summary of the response so
that user can have a look at it.
For due dates:
- If the user provides a day and month (e.g., "28th Feb" or "28 February"),
convert it into the current year (e.g., "2025-02-28").
- If the user provides a full date (e.g., "28th Feb 2025"), return it as is.
- If no year is provided, assume the current year which is 2025 and return
the date in the format YYYY-MM-DD.

For dynamic date terms:
- Today's date is ${todayDate}
- If the user says "today," convert that into **the current date** (e.g., if today is April 5, 2025, it should return "2025-04-05").
- If the user says "tomorrow," convert that into **the next day's date** (e.g., if today is April 5, 2025, "tomorrow" should be "2025-04-06").
- If the user says "next week," calculate the date of the same day in the following week (e.g., if today is April 5, 2025, "next week" would be April 12, 2025).
- If the user provides a phrase like "in X days," calculate the due date accordingly (e.g., "in 3 days" should become "2025-04-08").
- If the user provides terms like "next month," calculate the due date for the same day of the next month (e.g., if today is April 5, 2025, "next month" should become "2025-05-05").

For due times:
- Current time is ${currentTime}
- If the user provides a time in "AM/PM" format (e.g., "6 PM" or "6 AM"),
convert it into the 24-hour format:
- "6 AM" becomes "06:00"
- "6 PM" becomes "18:00"
- Ensure the output time is always in the 24-hour format (HH:mm).
- If the user says "next X hours" or "in X minutes," calculate the **current time** accordingly(e.g., if current time is 5:40 pm then "next 5 hours" will be 10:40 pm).

Conversation history: ${JSON.stringify(conversationHistory)}
User input: ${userMessage}
`;
    console.log("we are here===> 3");
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [{ role: "system", content: prompt }],
      });
      console.log("we are here===> 4");
      const botReply = response.choices[0].message.content;
      session.conversationHistory = conversationHistory;
      console.log("we are here===> 5", botReply);

      if (botReply[0] === "{") {
        const taskDetails = JSON.parse(botReply);

        const assigneeName = taskDetails.assignee.trim();

        console.log("assigneeName====>", assigneeName);

        const { data: matchingAssignees, error } = await supabase
          .from("grouped_tasks")
          .select("*")
          .ilike("name", `%${assigneeName}%`)
          .eq("employerNumber", From);

        if (error) {
          console.error("Error fetching assignees:", error);
          sendMessage(
            From,
            "Sorry, there was an error fetching the assignee data."
          );
          return;
        }

        console.log("FROM NUMBER===>", From);

        console.log("matchingAssignees====>", matchingAssignees);

        if (matchingAssignees.length > 1) {
          let message = `There are multiple people with the name "${assigneeName}". Please choose one:\n`;
          matchingAssignees.forEach((assignee, index) => {
            message += `${index + 1}. ${assignee.name}\n`;
          });
          console.log("message-new===>", message);

          sendMessage(From, message);
          session.step = 7;
          session.possibleAssignees = matchingAssignees;
          return;
        }

        sendMessage(
          From,
          `✅ *Task Summary*
Thank you for providing the task details! Here's a quick summary:

📝 *Task:* ${taskDetails.task}
👤 *Assignee:* ${taskDetails.assignee}
📅 *Due Date:* ${taskDetails.dueDate}
⏰ *Due Time:* ${taskDetails.dueTime}
🔁 *Reminder:* ${
    taskDetails.reminder_type === "one-time"
      ? `One-time at ${taskDetails.reminderDateTime}`
      : `Recurring ${taskDetails.reminder_frequency}`
  }`
        );
      } else {
        sendMessage(From, botReply);
      }

      if (botReply[0] === "{") {
        try {
          const taskData = JSON.parse(botReply);
          const assignedPerson = allData.find(
            (person) =>
              person.name.toLowerCase() === taskData.assignee.toLowerCase() &&
              person.employerNumber === From
          );
          console.log("assignedPerson--->", assignedPerson);
          console.log("taskData", taskData);
          if (assignedPerson) {
            let dueDateTime = `${taskData.dueDate} ${taskData.dueTime}`;
            if (
              taskData.task &&
              taskData.assignee &&
              taskData.dueDate &&
              taskData.dueTime
            ) {
              const newTask = {
                taskId: Date.now().toString(), // Simple ID generation; consider UUID for production
                task_details: taskData.task,
                task_done: "Pending",
                due_date: dueDateTime,
                reminder: "true",
                reminder_frequency: taskData.reminder_frequency,
                reason: null,
                started_at: getCurrentDate(),
                reminder_type: taskData.reminder_type || "recurring", // Default to recurring if not specified
                          reminderDateTime: taskData.reminderDateTime || null, // Store reminder date and time

              };

              const { data: existingData, error: fetchError } = await supabase
                .from("grouped_tasks")
                .select("tasks")
                .eq("name", taskData.assignee)
                .eq("employerNumber", From)
                .single();

              if (fetchError) {
                console.error("Error fetching existing tasks:", fetchError);
                sendMessage(From, "Error accessing assignee tasks.");
                return;
              }              

              const updatedTasks = existingData.tasks
                ? [...existingData.tasks, newTask]
                : [newTask];


              const { data, error } = await supabase
                .from("grouped_tasks")
                .update({ tasks: updatedTasks })
                .eq("name", taskData.assignee)
                .eq("employerNumber", From)
                .select();

              console.log("Matching Task:", data, error);
              if (error) {
                console.error("Error inserting task into Supabase:", error);
                sendMessage(From, "Error saving the task.");
              } else {
                console.log("Task successfully added to Supabase.");
                sendMessage(
                  From,
                  `📌 *Task Assigned*\n\nA new task, *${taskData.task}* has been assigned to *${taskData.assignee}*\n🗓️ *Due Date:* ${dueDateTime}`
                );
                sendMessage(
                  `whatsapp:+${assignedPerson.phone}`,
                  `📬 *New Task Assigned!*\n\nHello *${taskData.assignee}*,\nYou've been assigned a new task:\n\n📝 *Task:* *${taskData.task}*\n📅 *Deadline:* ${dueDateTime}`
                );
                delete userSessions[From];
                session.conversationHistory = [];

                await fetch(
                  "https://whatsappbot-task-management-be-production.up.railway.app/update-reminder",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      reminder_frequency: taskData.reminder_frequency,
                      taskId: newTask.taskId,
                      reminder_type: taskData.reminder_type || "recurring",
                      dueDateTime: dueDateTime, // Pass due date for one-time reminders
                      reminderDateTime: taskData.reminderDateTime
                    }),
                  }
                )
                  .then((res) => res.json())
                  .then((response) => {
                    console.log("taskID for reminder--->", newTask.taskId);

                    console.log("Reminder endpoint response:", response);
                  })
                  .catch((error) => {
                    console.error("Error triggering reminder endpoint:", error);
                  });
              }
            }
          } else {
            sendMessage(From, "Error: Could not find assignee.");
          }
        } catch (parseError) {
          console.error("Error parsing task details:", parseError);
        }
      }
    } catch (error) {
      console.error("Error processing user input with ChatGPT:", error);
      sendMessage(
        From,
        "Sorry, I couldn't process your message right now. Please try again."
      );
    }
  }
}

// ============================================================================
// VOICE TRANSCRIPTION FUNCTIONS
// ============================================================================

/**
 * Transcribe audio from a URL using OpenAI Whisper API
 * @param {string} mediaUrl - URL of the audio file
 * @returns {Promise<string|null>} Transcribed text or null
 */
async function transcribeAudioDirectly(mediaUrl) {
  try {
    // Twilio's Account SID and Auth Token
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Create Basic Auth header
    const authHeader =
      "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");

    const mediaResponse = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: accountSid,
        password: authToken,
      },
    });

    const form = new FormData();
    form.append("file", Buffer.from(mediaResponse.data), {
      filename: "audio.mp3",
      contentType: "audio/mp3",
    });
    form.append("model", "whisper-1");
    form.append("task", "translate");
    form.append("language", "hi");

    // Send directly to OpenAI Whisper for transcription
    const result = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    if (result && result.data) {
      console.log("Transcription result nwestttt======>:", result.data);
      return result.data.text;
    } else {
      console.log("No transcription result returned");
      return null;
    }
  } catch (error) {
    console.error(
      "Error transcribing audio:",
      error.response ? error.response.data : error.message
    );
    return null;
  }
}

// ============================================================================
// MEETING SCHEDULING FUNCTIONS
// ============================================================================

/**
 * Schedule a meeting in Google Calendar
 * @param {Object} args - Meeting details
 * @param {string} userNumber - User's phone number
 * @param {string} refreshToken - User's refresh token
 * @param {Object} res - Express response object
 */
async function scheduleMeeting({args, userNumber, refreshToken, res}) {
  console.log("I am in schedule meeting and next I am printing args");
  console.log(args);
  const {title, startDate, startTime, durationMinutes, attendees = [], recurrence, endDate } = args; 

  if(!startDate){ 
    const twiml = new MessagingResponse(); 
    twiml.message("Start date missing. Please reply with a date like May 7 2025"); 
    return res.type("text/xml").send(twiml.toString()); 
  }
  // const naturalInput = `${date} ${startTime}`;
  const naturalInput = `${moment(startDate).format("YYYY-MM-DD")} ${startTime}`;
  const parsedDateTime = chrono.parseDate(naturalInput, new Date(), { forwardDate: true});
  console.log("I am printing parsed date and time"); 
  if (!parsedDateTime) {
    const twiml = new MessagingResponse();
    twiml.message(
      "⚠️ Couldn't understand the date and time. Please try again with a specific time and date like 'April 12 at 14:00'."
    );
    return res.type("text/xml").send(twiml.toString());
  }
  // ✅ Convert parsed time to IST using moment-timezone
  const startDateTime = moment(parsedDateTime);
  const endDateTime = startDateTime.clone().add(durationMinutes, "minutes");

  const oAuth2Client = getOAuthClient(refreshToken);
  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

  console.log("Parsed values from OpenAI:");
  console.log("Title:", title);
  console.log("Date:", startDate);
  console.log("startDateTime:", startDateTime.toISOString());
  console.log("endDateTime:", endDateTime.toISOString());
  console.log("Start Time:", startTime);
  console.log("Duration (mins):", durationMinutes);
  console.log("i am printing attendees")
  console.log("Attendees:", attendees);
  console.log("i am about to print recurrence")
  console.log("Recurrence:", recurrence);
  console.log("i am printing end date required for recurring meeting"); 
  console.log("end date:", endDate); 

  const event = {
    summary: title,
    start: {
      dateTime: startDateTime.format("YYYY-MM-DDTHH:mm:ss"), // ⬅️ key change
      timeZone: "Asia/Kolkata",
    },
    end: {
      dateTime: endDateTime.format("YYYY-MM-DDTHH:mm:ss"), // ⬅️ key change
      timeZone: "Asia/Kolkata",
    },
    attendees: attendees.map((email) => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: Math.random().toString(36).substring(2),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    recurrence: recurrence ? [recurrence] : undefined, 
  };

  
  if (recurrence && endDate) {
    const parsedEndDate = chrono.parseDate(endDate); 
    console.log(" i have the end date now")
    const shiftedEndDate = moment(parsedEndDate).add(1, "day");
    const untilDate = shiftedEndDate.utc().format("YYYYMMDD[T]000000[Z]"); 
    const updatedRecurrence = `${recurrence};UNTIL=${untilDate}`;
    event.recurrence = [updatedRecurrence];
  }

  let calendarResponse;
  try {
    calendarResponse = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: "all",
    });
  } catch (error) {
    console.error("Calendar error:", error);
    const twiml = new MessagingResponse();
    twiml.message("Failed to create calendar invite. Try again.");
    return res.type("text/xml").send(twiml.toString());
  }

  const twiml = new MessagingResponse();
  twiml.message(
    `Meeting created! 📅\nTitle: ${title}\nDate: *${startDateTime.format(
      "ddd MMM DD YYYY"
    )}*\nTime: *${startDateTime.format("h:mm A")} IST*\nLink: ${
      calendarResponse.data.hangoutLink
    }`
  );
  return res.type("text/xml").send(twiml.toString());
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * Initialize the WhatsApp webhook and other routes
 */
async function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const { Body, From } = req.body;

    todayDate = getFormattedDate();
    currentTime = getFormattedTime();

    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    let userMessage = Body.trim();

    let incomingMsg = Body.trim();

    const userNumber = req.body.From;

    const refreshToken = await getRefreshToken(userNumber);

    console.log("Before correction response / calling date function", new Date().toISOString());

    console.log("I have first come to correction response");

    const correctionResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system", 
          content: `
    You are a helpful assistant that automatically corrects typos in user input.
    
    Fix spelling, grammar, and time-related issues (like "30pm" → "3pm", "muns" → "mins").
    
    Always respond in JSON format:
    {
      "original": "user's original input",
      "corrected": "corrected version of the input"
    }
    `
        }, 
        {
          role: "user",
          content: userMessage, 
        }, 
      ]
    }); 
    
    let correctedData;
    
    // ✅ Step 1: Safely check and parse the GPT response
    if (
      correctionResponse &&
      correctionResponse.choices &&
      correctionResponse.choices.length > 0 &&
      correctionResponse.choices[0].message?.content
    ) {
      try {
        correctedData = JSON.parse(correctionResponse.choices[0].message.content.trim());
        console.log("Corrected data:", correctedData);
      } catch (e) {
        console.error("Failed to parse GPT response as JSON:", correctionResponse.choices[0].message.content);
        correctedData = { original: userMessage, corrected: userMessage }; // fallback
      }
    } else {
      console.error("Empty or malformed GPT correction response:", correctionResponse);
      correctedData = { original: userMessage, corrected: userMessage }; // fallback
    }
    
    // ✅ Step 2: Apply correction if different
    if (correctedData?.corrected && correctedData.original !== correctedData.corrected) {
      console.log("Auto-correcting input:", correctedData.original, "→", correctedData.corrected);
      userMessage = correctedData.corrected;
    } else {
      console.log("No correction needed. Using original input:", userMessage.trim());
      userMessage = userMessage.trim();
    }
    
    // incoming change - see if this is needed 
    //   incomingMsg.toLowerCase().includes("schedule") ||
    //   (sessions[userNumber] && sessions[userNumber].pendingMeeting)
    // ) {
    //   console.log("MEETING FUNC TRIGGERED!!!");

    // Handle pending session states for meeting scheduling
    console.log("printing user session pending args outside if ", sessions[userNumber]?.pendingArgs); 
    
    if (sessions[userNumber]?.pendingArgs) {
      console.log("printing user session pending args inside if", sessions[userNumber]?.pendingArgs); 
      console.log("printed correction response now handling pending args");
      const pending = sessions[userNumber]; 
      const args = pending.pendingArgs; 
      console.log("I am going ahead and printing args"); 
      console.log(args);
      console.log("✅ args.startdate =", args.startDate);
      console.log("✅ args.startTime =", args.startTime);


      if(!args) {
        console.log("No pending args"); 
        return; 
      }

      
      console.log("here before all the pending ifs start"); 

      if (pending.awaitingStartDate) {
        console.log("start date missing and am assigning it"); 
        args.startDate = userMessage;
        console.log("here is the assigned start date", args.startDate); 
      } else if (pending.awaitingEndDate) {
        args.endDate = userMessage; 
      } else if (pending.awaitingTitle){
        args.title = userMessage; 
      }  else if (pending.awaitingStartTime){
        console.log("start time missing, I have it and now I am assigning it");
        args.startTime = userMessage; 
        console.log("I have assigned start time -->", args.startTime);
        const validTime = await parseAndValidateClockTime(userMessage, args.startDate, args, userNumber, res);
        if (!validTime) return;
      } else if (pending.awaitingDuration) {
        console.log("duration was missing, I have it and now I am assigning it");
       // args.durationMinutes = parseInt(userMessage); 

        // first fallback verification 
        if (isValidDuration(userMessage.trim())) {
          const numMatch = userMessage.match(/\d+/);
          args.durationMinutes = numMatch ? parseInt(numMatch[0]) : null;
        } 
        else {
          // ❌ Ask the user again using GPT for clarity
          const gptCheck = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
              {
                role: "system",
                content: "You are an AI assistant. Determine if this phrase refers to a meeting duration (e.g., '30 minutes') or something else. If it's a duration, reply ONLY with the number in minutes (e.g., '30'). Otherwise, reply: 'unclear'."
              },
              {
                role: "user",
                content: userMessage
              }
            ]
          });
      
          const reply = gptCheck.choices?.[0]?.message?.content?.trim();
          console.log("gpt reply", reply); 
          console.log("GPT reply for duration classification:", reply);
      
          const parsed = parseInt(reply);
          if (!isNaN(parsed)) {
            args.durationMinutes = parsed;
          } else {
            // Still unclear, ask user directly
            sessions[userNumber] = { awaitingDuration: true, pendingArgs: args };
            const twiml = new MessagingResponse();
            twiml.message("⏱ I couldn’t understand how long the meeting should be. Please reply with a duration like '30 minutes'.");
            return res.type("text/xml").send(twiml.toString());
          }
        }
        
             
      } else if (pending.awaitingAttendees) {
        args.attendees = userMessage.split(/[ ,]+/);
      } else {
        return; 
      }

      delete pending.awaitingTitle;
      delete pending.awaitingStartDate; 
      delete pending.awaitingDuration;
      delete pending.awaitingAttendees;
      delete pending.awaitingEndDate;
      delete pending.pendingArgs; 

      if (!args.title) {
        sessions[userNumber] = { awaitingTitle: true, pendingArgs: args };
        const twiml = new MessagingResponse();
        twiml.message("What should we call this meeting? Please provide a title (e.g., 'Team Sync').");
        return res.type("text/xml").send(twiml.toString());
      }

      

      if (!args.startTime) {
        sessions[userNumber] = { awaitingStartTime: true, pendingArgs: args };
        const twiml = new MessagingResponse();
        console.log("I am in first if statement of start time missing");
        twiml.message("Please provide a clear start time for the meeting (e.g., 10:00 AM).");
        return res.type("text/xml").send(twiml.toString());
      }

      // Reject past or hallucinated dates like 2022
      if (args.startDate) {
        console.log("Entered args.startDate block");
      
        const rawStartDate = args.startDate;
      
        // Pattern to match formats like "May 28, 2025"
        const humanDatePattern = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s*\d{4}/gi;
      
        // Normalize any human-readable date inside the string to "YYYY-MM-DD"
        const normalizedStartDate = rawStartDate.replace(humanDatePattern, (match) => {
          return moment(match).format("YYYY-MM-DD");
        });
      
        console.log("Normalized start date string:", normalizedStartDate);
      
        const parsedDate = moment(normalizedStartDate, "YYYY-MM-DD", true);
        console.log("Parsed date object:", parsedDate);
      
        if (!parsedDate.isValid() || parsedDate.isBefore(moment(), "day")) {
          sessions[userNumber] = {
            awaitingStartDate: true,
            pendingArgs: args,
          };
      
          const twiml = new MessagingResponse();
          twiml.message("Seems like you haven't provided a date or I missed catching it. Please reply with a valid future date (e.g., May 30, 2025).");
          return res.type("text/xml").send(twiml.toString());
        }
      
        // ✅ If valid date, update args.startDate for downstream use
        args.startDate = parsedDate.format("YYYY-MM-DD");
      }
      


      // if (!args.startDate) {
      //   sessions[userNumber] = { awaitingStartDate: true, pendingArgs: args };
      //   const twiml = new MessagingResponse();
      //   twiml.message("When should this meeting happen? Please provide the date (e.g., May 6, 2025).");
      //   return res.type("text/xml").send(twiml.toString());
      // }

      // if (!args.durationMinutes) {
      //   sessions[userNumber] = { awaitingDuration: true, pendingArgs: args };
      //   const twiml = new MessagingResponse();
      //   twiml.message("How long should this meeting be? Please reply with the duration in minutes (e.g., 30).");
      //   return res.type("text/xml").send(twiml.toString());
      // }
      // 🧠 After GPT returns args
      if (!args.durationMinutes || /a\s*while|some\s*time|soon|later|eventually/i.test(args.durationMinutes)) {
        sessions[userNumber] = {
          awaitingDuration: true,
          pendingArgs: args,
        };
        console.log("I am in args duration if statement");
        const twiml = new MessagingResponse();
        twiml.message("⏱️ How long should this meeting be? Please reply with a clear duration (e.g., 30 minutes, 1 hour).");
        return res.type("text/xml").send(twiml.toString());
      }


      if (!args.attendees || args.attendees.length === 0) {
        sessions[userNumber] = { awaitingAttendees: true, pendingArgs: args };
        const twiml = new MessagingResponse();
        twiml.message("Who should be invited to this meeting? Please reply with one or more email addresses.");
        // incoming change - see if this is needed 
        // twiml.message(
        //   `📅 Ready to schedule your meeting? Sign in with Google to continue: ${await shortenUrl(
        //     authUrl
        //   )} 🛡️`
        // );
        // return res.type("text/xml").send(twiml.toString());
      }

      let validclocktime = false; 

      validclocktime = isValidClockTime(args.startDate, args.startTime); 
      console.log("printing valid clock time", validclocktime); 
      if (!validclocktime) {
        sessions[userNumber] = {
          awaitingStartTime: true,
          pendingArgs: args,
        };
      
        const twiml = new MessagingResponse();
        twiml.message("⏰ I couldn’t understand the time you provided. Please reply with a specific time like '10:00 AM'.");
        return res.type("text/xml").send(twiml.toString());
      }

      if(!args.endDate && args.recurrence) {
        sessions[userNumber] = {
           awaitingEndDate: true, 
           pendingArgs: args, 
        };
        
        const twiml = new MessagingResponse(); 
        twiml.message("You mentioned a recurring meeting, but didn't specify the end date. Please reply with an end date")
        return res.type("text/xml").send(twiml.toString()); 
      }

      const refreshToken = await getRefreshToken(userNumber); 
      console.log("I am in args check above area and now going to call schedulemeeting");
      await scheduleMeeting({ args, userNumber, refreshToken, res}); 
      delete sessions[userNumber]; 
      return; 
    } // Handle meeting scheduling if statement 
    if (
      (incomingMsg.toLowerCase().includes("schedule") ||
        incomingMsg.toLowerCase().includes("meeting")) ||
      (sessions[userNumber] && sessions[userNumber].pendingMeeting)
    ) {
      console.log("MEETING WORD TRIGGERED!!!");

      const userMsg = req.body.Body;

      const isMeetingTrigger = 
      (userMessage.toLowerCase().includes("schedule") &&
        /(meeting|call|sync|standup|check[- ]?in)/i.test(userMessage)) ||
      sessions[userNumber]?.awaitingEndDate;

      console.log("Meeting trigger = ", isMeetingTrigger); 

      if(isMeetingTrigger) {
        if (!refreshToken) {
          const authUrl = new google.auth.OAuth2(
            process.env.CLIENT_ID,
            process.env.CLIENT_SECRET,
            process.env.REDIRECT_URI
          ).generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: ["https://www.googleapis.com/auth/calendar"],
            state: `whatsapp:${userNumber}`,
          });

          const twiml = new MessagingResponse();
          twiml.message(
            `To schedule meetings, please sign in with Google: ${authUrl}`
          );
          return res.type("text/xml").send(twiml.toString());
        }
        
        console.log("I am at this point in the meeting trigger if statement");
        console.log("checking session", sessions[userNumber]);
        console.log("awaitingEndDate?", sessions[userNumber]?.awaitingEndDate);
        console.log("pendingArgs?", sessions[userNumber]?.pendingArgs);
        console.log("start date", sessions[userNumber]?.awaitingStartDate);

        console.log("user message", userMessage); 

        // Initialize new session if not exists 
        if(!sessions[userNumber]) {
          sessions[userNumber] = {
            history: [
              {
                role: 'system',
                content: `You are a helpful assistant that schedules meetings using Google Calendar.

Always try to correct any typos or spelling mistakes in the user's message. For example:
- 'forwednesdau' → 'for Wednesday'
- 'teem sync' → 'team sync'

Your task is to first analyze the user's message and check if it contains all required information to schedule a meeting:
- Cleanly extract: 
  - Email of the invitee
  - Title or topic of the meeting
  - Date of the meeting (YYYY-MM-DD)
  - Start time of the meeting (just the time like '10:00AM', not 'every Monday 10AM')
  - Duration of the meeting in minutes
  - Attendees (email array)
  - Recurrence in RRULE format (like 'RRULE:FREQ=WEEKLY;BYDAY=MO')
  - (For recurring meetings) End date of recurrance (until when it should repeat)

Never include phrases like "forever", "every Monday", or "daily" in the start time. The recurrence rule should capture that instead.
- Do NOT guess the start time. If it's unclear or missing, return nothing and wait for the user to confirm it.

IMPORTANT TIME EXTRACTION RULES: - Never include phrases like "forever", "every Monday", "daily", "weekly", or any recurrence terms in the start time field. 
- Words like "forever" should ONLY be considered for recurrence patterns, NEVER as time values.
- The start time must be a specific clock time (like "9:00 AM" or "14:30"). 
- If no specific clock time is provided, leave the startTime field empty (null or undefined). 
- Do NOT guess or infer a start time if none is explicitly stated. 
- The recurrence rule should capture frequency patterns, not the start time field. 
For example: - "schedule team sync forever monday beginning may 12th 2025" → No start time provided, leave startTime empty - "schedule meeting at 3pm every day" → startTime should be "3:00 PM" \`

IMPORTANT DATE RULES: - Never return relative date terms like "tomorrow", "next week", or "today".
- Always convert them to an actual date in the format YYYY-MM-DD.
- The current date is: ${todayDate}
-  Use the current date it resolve expressions like "tomorrow", "next Monday", or "in two days" into exact calendar dates.
- Always return an actual calendar date in YYYY-MM-DD format based on today: 2025-05-06.

IMPORTANT: If the user says something like "10 mins" or "30 minutes", treat that as duration — NOT start time.

If the start time is unclear or looks like a duration, leave it blank. Do NOT fill startTime with vague or incorrect values.


Examples:
- Input: "Schedule daily sync at 10 AM with team@example.com for 30 mins starting May 6"
  → Output:
    {
      "title": "daily sync",
      "date": "2025-05-06",
      "startTime": "10:00 AM",
      "durationMinutes": 30,
      "attendees": ["team@example.com"],
      "recurrence": "RRULE:FREQ=DAILY"
    }

Only return clean fields.

If any information is missing or unclear, ask a simple follow-up question.

You MUST check for missing or ambiguous fields. Be especially strict about time ambiguity:
- If a time like "8" or "tomorrow 8" is mentioned without AM/PM, ask the user to clarify.
- Never assume AM or PM.
- Phrases like "8", "5", or "at 3" without a clear indication of AM/PM or 24-hour format should be considered ambiguous.
- If the year is missing in date of the meeting always assume the year as current year which is ${new Date().getFullYear()}

For dynamic date terms:
- Today's date is ${todayDate}.
- If the user says "today," convert that into **the current date** (e.g., if today is April 5, 2025, it should return "2025-04-05").
- If the user says "tomorrow," convert that into **the next day’s date** (e.g., if today is April 5, 2025, "tomorrow" should return "2025-04-06").
- If the user says "next week," calculate the date of the same day in the following week (e.g., if today is April 5, 2025, "next week" would return "2025-04-12").
- If the user says "in X days," calculate the due date accordingly (e.g., "in 3 days" should return "2025-04-08").
- If the user says "next month," calculate the due date for the same day of the next month (e.g., if today is April 5, 2025, "next month" should return "2025-05-05").

For dynamic time terms:
- Current time is ${currentTime}.
- If the user says "next X hours" or "in X minutes," calculate the **current time** accordingly (e.g., if the current time is 5:40 PM, then "next 5 hours" will be 10:40 PM).

You also support **recurring meeetings**:
- If the user says "daily", "every day", "weekly", "every Monday", "recurring" or "monthly", treat it as recurring meeting. 
- If the recurrence is clear, return it in this RRULE format: 
  - "daily" → "RRULE:FREQ=DAILY"
  - "weekly on Monday" → "RRULE: FREQ=WEEKLY;BYDAY="MO"
  - "monthly on 1st"→ "RRULE:FREQ=MONTHLY;BYMONTHDAY=1"

You must ensure:
- The meeting has a **start date** (YYYY-MM-DD)
- For **recurring meetings**, you must also ask for:
     - A **start date** (if not specified). 
     - An **end date** (until when the meeting should repeat). 
  

- If all details are clear, return nothing (leave response empty). 

If anything is unclear or missing (including end date for recurring meetings), respond with a plain text clarification question. For example:
"I noticed you said 'tomorrow 8'. Did you mean 8 AM or 8 PM? Please reply with the exact time."
"If someone says "every Monday at 8", ask: "What date should this recurring meeting start from?"
"If someone says "daily at 5pm", ask: "From which date should this repeat?" 
"Never hallucinate or infer old or ambiguous dates. Only return a date if you're confident it's in the future. If you're unsure, leave the date field blank and let the user confirm it."

If the message is clear, contains all the required fields (invitee email, meeting title, date, time with AM/PM, and duration), and there is no ambiguity, proceed to schedule the meeting **immediately** without sending a confirmation or asking the user to respond again.

Do NOT reply with a summary or confirmation message if all the required fields are present and unambiguous. Simply schedule the meeting silently.
`,
            },
          ],
          pendingMeeting: false,
        };
      }

        // Generate reply with full context
        const completion = await openai.chat.completions.create({
          model: "gpt-4",
          messages: sessions[userNumber].history,
          functions: [
            {
              name: "create_calendar_event",
              parameters: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  startDate: { type: "string", format: "date" },
                  startTime: { type: "string" },
                  durationMinutes: { type: "number" },
                  attendees: {
                    type: "array",
                    items: { type: "string", format: "email" },
                  },
                  recurrence: {
                    type: "string",
                    description: "Optional, RRULE format for recurrence (e.g., 'RRULE:FREQ=DAILY')"
                  },
                  endDate: {
                    type: "string", 
                    format: "date", 
                    description: "End date for recurring meetings (YYYY-MM-DD)"
                  }
                },
                required: ["title", "date", "startTime", "durationMinutes"]
              }
            }
          ],
          function_call: { name: "create_calendar_event" }
        });

        const gptReply = completion.choices[0].message;

        // Save assistant message for context continuity
        sessions[userNumber].history.push(gptReply);

        // If function call is not triggered yet, GPT is asking for more info
        if (!gptReply.function_call) {
          sessions[userNumber].pendingMeeting = true;

          const twiml = new MessagingResponse();
          twiml.message(gptReply.content || "Could you provide more details?");
          return res.type("text/xml").send(twiml.toString());
        }

        const args = JSON.parse(gptReply.function_call.arguments);
        console.log("printing all the args after gpt response");
        console.log(args);
        const { title, startDate, startTime, durationMinutes, attendees = [], recurrence, endDate } = args;

        // if recurrence exists but no start date, ask the user
        console.log("printing args date", args.startDate);
        console.log("printing startdate after gpt response sessions",sessions[userNumber].startDate)
        //console.log("date, printing date just date", date); 

        console.log("printing the starttime", startTime); 
        // Fuzzy or missing start time

        
        // const fuzzyTerms = /forever|ish|someday|later|evening|morning|midday|whenever/i;
        // if (!startTime || fuzzyTerms.test(startTime)) {
        //   sessions[userNumber] = {
        //     awaitingStartTime: true,
        //     pendingArgs: args,
        //   };
        //   const twiml = new MessagingResponse();
        //   console.log("at second if / fuzzy terms if statement");
        //   twiml.message("Please provide a clear start time for the meeting (e.g., 10:00 AM).");
        //   return res.type("text/xml").send(twiml.toString());
        // }

        if (!title) {
          sessions[userNumber] = { awaitingTitle: true, pendingArgs: args };
          const twiml = new MessagingResponse();
          twiml.message("What should we call this meeting? Please provide a title (e.g., 'Team Sync').");
          return res.type("text/xml").send(twiml.toString());
        }

        if (!durationMinutes) {
          sessions[userNumber] = { awaitingDuration: true, pendingArgs: args };
          const twiml = new MessagingResponse();
          twiml.message("How long should this meeting be? Please reply with the duration in minutes (e.g., 30).");
          return res.type("text/xml").send(twiml.toString());
        }

        if (!attendees || attendees.length === 0) {
          sessions[userNumber] = { awaitingAttendees: true, pendingArgs: args };
          const twiml = new MessagingResponse();
          twiml.message("Who should be invited to this meeting? Please reply with one or more email addresses.");
          return res.type("text/xml").send(twiml.toString());
        }

       
        
        if(!startDate) {
          sessions[userNumber].awaitingStartDate = true; 
          sessions[userNumber].pendingArgs = args; 

          const twiml = new MessagingResponse(); 
          console.log("I am at the late if check for date");
          if(recurrence) {
             twiml.message("You mentioned a recurring meeting, but didn't specify the start date. Please reply with a start date."); 
          } else {
            twiml.message("When should this meeting happen? Please provide the date (May 6, 2025)"); 
          }

          return res.type("text/xml").send(twiml.toString()); 
        }
        console.log("I am outside the second if date check");
        console.log("recurrence", recurrence); 
        console.log("endDate", endDate);

        // If recurrence exists but no endDate, ask the user
        if (recurrence && !endDate) {
          sessions[userNumber].awaitingEndDate = true;
          console.log("I am here, there is no end date"); 
          sessions[userNumber].pendingArgs = args; 
          console.log("printing pending date", sessions[userNumber].pendingArgs); 

          const twiml = new MessagingResponse();
          twiml.message("You mentioned a recurring meeting but didn't specify until when it should repeat. Please reply with an end date.");
          console.log("before return, printing awaiting date", sessions[userNumber].awaitingEndDate)
          console.log("pending args", sessions[userNumber].pendingArgs); 
          return res.type("text/xml").send(twiml.toString());
        }

        console.log("outside if printing sessions awaiting date", sessions[userNumber].awaitingEndDate);
        console.log("printing args");
        console.log(args); 
        console.log("at the bottom and calling scheduleMeeting");
        await scheduleMeeting({ args, userNumber, refreshToken, res });
        console.log("I am here before delete")
        delete sessions[userNumber];
        console.log("the session has been deleted")
        return;
      }

      const twiml = new MessagingResponse();
      twiml.message(
        `✅ Meeting successfully created! 🎉\n📝 *Title:* ${title}\n📅 *Date:* ${startDateTime.format(
          "ddd MMM DD YYYY"
        )}\n🕒 *Time:* ${startDateTime.format("h:mm A")} IST\n🔗 *Link:* ${
          calendarResponse.data.hangoutLink
        }`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Handle voice message transcription
    if (mediaUrl && mediaType && mediaType.startsWith("audio")) {
      console.log(`Received a voice message from`);
      console.log(`Media URL: ${mediaUrl}`);

      const transcription = await transcribeAudioDirectly(mediaUrl);

      if (transcription) {
        userMessage = transcription;
      }

      const apiKey = process.env.WORDWARE_API_KEY;
      const requestBody = {
        inputs: {
          your_text: userMessage,
        },
        version: "^2.0",
      };

      const response = await axios.post(
        "https://app.wordware.ai/api/released-app/8ab2f459-fee3-4aa1-9d8b-fc6454a347c3/run",
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("res====?>", response.data);

      const responseValue = response.data.trim().split("\n");

      let parsedChunks = responseValue.map((chunk) => JSON.parse(chunk));

      console.log(
        "parsedChunks length",
        parsedChunks[parsedChunks.length - 1].value.values.new_generation
      );

      const cleanText =
        parsedChunks[parsedChunks.length - 1].value.values.new_generation;

      console.log("clean text====>", cleanText);

      userMessage = cleanText;
    }

    // Respond with an HTTP 200 status
    res.status(200).send("<Response></Response>");

    // Standard task management workflow here 
    console.log("I have come to standard task management flow"); 
    if (!userSessions[From]) {
      userSessions[From] = {
        step: 0,
        task: "",
        assignee: "",
        dueDate: "",
        dueTime: "",
        assignerNumber: From,
        conversationHistory: [],
      };
    }
    console.log(userMessage, From);
    await handleUserInput(userMessage, From);
    res.end();
  });

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state || !state.startsWith("whatsapp:")) {
    return res.send("Invalid request");
  }

  const userNumber = state.replace("whatsapp:", "");
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

    try {
      const { tokens } = await oAuth2Client.getToken(code);
      if (!tokens.refresh_token) {
        return res.send("❌ Google didn't return a refresh token. Try again.");
      } //if end 
      console.log('tokens', tokens);
      
      const saved = await saveRefreshToken(userNumber, tokens.refresh_token);
      if (!saved) return res.send('❌ Failed to save token.');

      return res.send('✅ Authentication successful! You can now schedule meetings on WhatsApp.');
    } // catch (err) {
    //   console.error('OAuth error:', err.message);
    //   res.send('❌ Failed to authenticate with Google.');
    // }
  });

  // Update reminder route
  app.post("/update-reminder", async (req, res) => {
    const { reminder_frequency } = req.body;

    console.log("inside be update-reminder req.body", reminder_frequency);

    if (isCronRunning) {
      console.log("Cron job already running. Ignoring duplicate trigger.");
      return res.status(200).json({ message: "Reminder already scheduled" });
    }

    isCronRunning = true;

    const frequencyPattern =
      /(\d+)\s*(minute|min|mins|hour|hrs|hours|day|days)s?/;
    const match = reminder_frequency.match(frequencyPattern);

    console.log("frequencyPattern, match", frequencyPattern, match);

    if (!match) {
      console.log("Invalid reminder frequency format");
      return res
        .status(400)
        .json({ message: "Invalid reminder frequency format" });
    }

    const quantity = parseInt(match[1], 10); // Extract the numeric part
    const unit = match[2]; // Extract the unit (minute, hour, day)

    console.log("quantity, unit", quantity, unit);

    let cronExpression = "";

    // Construct the cron expression based on the unit
    if (unit === "minute" || unit === "min" || unit === "mins") {
      cronExpression = `*/${quantity} * * * *`; // Every X minutes
    } else if (unit === "hour" || unit == "hours" || unit === "hrs") {
      cronExpression = `0 */${quantity} * * *`; // Every X hours, at the start of the hour
    } else if (unit === "day" || unit === "days") {
      cronExpression = `0 0 */${quantity} * *`; // Every X days, at midnight
    } else {
      console.log("Unsupported frequency unit");
      return res.status(400).json({ message: "Unsupported frequency unit" });
    }

    cron.schedule(cronExpression, async () => {
      console.log("Checking for pending reminders...");

      const { data: tasks, error } = await supabase
        .from("tasks")
        .select("*")
        .eq("reminder", true)
        .neq("task_done", "Completed")
        .neq("task_done", "No")
        .neq("task_done", "Reminder sent")
        .not("tasks", "is", null)
        .neq("tasks", "");

      if (error) {
        console.error("Error fetching reminders:", error);
        return;
      }

      console.log(`Found ${tasks.length} tasks to remind`);

      for (const task of tasks) {
        console.log("Sending reminder to:", task.phone);
        sendMessage(
          `whatsapp:+${task.phone}`,
          `Reminder: Has the task "${task.tasks}" assigned to you been completed yet? Reply with Yes or No.`
        );

        userSessions[`whatsapp:+${task.phone}`] = { step: 5, task: task.tasks };
      }
    });

    res.status(200).json({ message: "Reminder scheduled" });
  });
}

// Refresh tasks route
app.get("/refresh", async (req, res) => {
  console.log("Refreshing tasks from Supabase...");
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) {
    console.error("Error refreshing tasks:", error);
    return res.status(500).json({ message: "Error fetching tasks" });
  }
  allData = data;
  console.log("Tasks updated!");
  res
    .status(200)
    .json({ message: "Tasks refreshed successfully", tasks: allData });
    console.log("tokens", tokens);

    const saved = await saveRefreshToken(userNumber, tokens.refresh_token);
    if (!saved) return res.send("❌ Failed to save token.");

    return res.send(
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Authentication Success</title>
    <style>
      body {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        font-family: Arial, sans-serif;
        background-color: #f0f0f0;
      }
      .card {
        background-color: #ffffff; /* Changed to white background */
        color: #333; /* Changed text color for contrast */
        padding: 20px;
        border-radius: 10px;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        text-align: center;
        max-width: 45%;
      }
      .card img {
        width: 150px;
        height: 150px;
        vertical-align: middle;
        margin-right: 10px;
      }

      .continue-button {
        background-color: #4CAF50;
        color: white;
        border: none;
        padding: 10px 30px;
        text-align: center;
        text-decoration: none;
        display: inline-block;
        font-size: 16px;
        font-weight: bold;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.2s ease;
        margin-top: 15px;
    }

    .continue-button:hover {
        background-color: #45a049;
        transform: scale(1.05);
    }

    .continue-button:active {
        background-color: #3e8e41;
        transform: scale(0.98);
    }
    </style>
  </head>
  <body>
    <div class="card">
      <div>
        <img src="https://rxmjzmgvxbotzfqhidzd.supabase.co/storage/v1/object/public/images//thumbsup.png" alt="Thumbs Up" />
      </div>

      <div>
        <h2>✅ Authentication Successful! 🎉<br /></h2>

        <h3 style="font-size: 25px;">
            You can now schedule any meetings on WhatsApp 📅📱
        </h3>
      </div>

      <div>
        <a href="https://wa.me/15557083934" target="_blank">
            <button class="continue-button">👉 Continue</button>
        </a>
    </div>
    </div>
  </body>
</html>`
    );
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.send("❌ Failed to authenticate with Google.");
  }
});

let isCronRunning = false; // Track if the cron job is active
const cronJobs = new Map(); // Map to store cron jobs for each task

app.post("/update-reminder", async (req, res) => {
  const { reminder_type, reminder_frequency, taskId, dueDateTime, reminderDateTime } = req.body;

  console.log("inside be update-reminder req.body", req.body);

  if (cronJobs.has(taskId)) {
    console.log(
      `Cron job already exists for task ${taskId}. Ignoring duplicate trigger.`
    );
    return res.status(200).json({ message: "Reminder already scheduled" });
  }

  const sendReminder = async () => {
    console.log(`Checking reminder for task ${taskId}...`);

    const { data: groupedData, error } = await supabase
      .from("grouped_tasks")
      .select("name, phone, tasks");

    if (error) {
      console.error("Error fetching grouped_tasks", error);
      return;
    }

    const matchedRow = groupedData.find((row) =>
      row.tasks?.some((task) => task.taskId === taskId)
    );

    if (!matchedRow) {
      console.log(
        `No matching task found for task ${taskId}. Stopping reminder.`
      );
      cronJobs.get(taskId)?.stop();
      cronJobs.delete(taskId);
      return;
    }

    const matchedTask = matchedRow.tasks.find((task) => task.taskId === taskId);

    if (
      matchedTask.reminder !== "true" ||
      matchedTask.task_done === "Completed" ||
      matchedTask.task_done === "No" ||
      matchedTask.task_done === "Reminder sent" ||
      !matchedTask.task_details
    ) {
      console.log(
        `Task ${taskId} doesn't need reminder anymore. Stopping reminder.`
      );
      cronJobs.get(taskId)?.stop();
      cronJobs.delete(taskId);
      return;
    }

    console.log(`Sending reminder to: ${matchedRow.phone} for task ${taskId}`);

    // send TEMPORARY due date and time for one-time reminders
    sendMessage(
      `whatsapp:+${matchedRow.phone}`,
      `⏰ *Reminder*\n\nHas the task *${matchedTask.task_details}* assigned to you been completed yet?\n✉️ Reply with Yes or No.\n📅 *Due:* ${matchedTask.due_date}`
    );

    userSessions[`whatsapp:+${matchedRow.phone}`] = {
      step: 5,
      task: matchedTask.task_details,
      assignee: matchedRow.name,
      taskId: taskId,
    };

    // For one-time reminders, mark task to stop further reminders
    if (reminder_type === "one-time") {
      const { data: existingData } = await supabase
        .from("grouped_tasks")
        .select("tasks")
        .eq("name", matchedRow.name)
        .single();

      const updatedTasks = existingData.tasks.map((task) =>
        task.taskId === taskId ? { ...task, reminder: "false" } : task
      );

      await supabase
        .from("grouped_tasks")
        .update({ tasks: updatedTasks })
        .eq("name", matchedRow.name);

      cronJobs.delete(taskId); // Clean up
    }
  };

  if (reminder_type === "one-time") {
    // Schedule one-time reminder at dueDateTime
    const now = moment().tz("Asia/Kolkata");
    const reminderTime = moment.tz(reminderDateTime, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
    // const reminderTimeWithOffset = reminderTime.clone().subtract(20, "minutes");
    const delay = reminderTime.diff(now);

    if (delay <= 0) {
      console.log(`Task ${taskId} due date is in the past. Sending reminder now.`);
      await sendReminder();
      return res.status(200).json({ message: "One-time reminder sent" });
    }

    setTimeout(async () => {
      await sendReminder();
    }, delay);

    cronJobs.set(taskId, { type: "one-time" }); // Store for tracking
    console.log(`Scheduled one-time reminder for task ${taskId} at ${dueDateTime}`);
    return res.status(200).json({ message: "One-time reminder scheduled" });
  } else {
    // Handle recurring reminders (existing logic)
    const frequencyPattern =
      /(\d+)\s*(minute|min|mins|hour|hr|hrs|hours|day|days)s?/;
    const match = reminder_frequency?.match(frequencyPattern);

    if (!match) {
      console.log("Invalid reminder frequency format");
      return res
        .status(400)
        .json({ message: "Invalid reminder frequency format" });
    }

    const quantity = parseInt(match[1], 10);
    const unit = match[2];

    let cronExpression = "";
    if (unit === "minute" || unit === "min" || unit === "mins") {
      cronExpression = `*/${quantity} * * * *`;
    } else if (
      unit === "hour" ||
      unit === "hours" ||
      unit === "hrs" ||
      unit === "hr"
    ) {
      cronExpression = `0 */${quantity} * * *`;
    } else if (unit === "day" || unit === "days") {
      cronExpression = `0 0 */${quantity} * *`;
    } else {
      console.log("Unsupported frequency unit");
      return res.status(400).json({ message: "Unsupported frequency unit" });
    }

    const cronJob = cron.schedule(cronExpression, sendReminder);
    cronJobs.set(taskId, cronJob);
    console.log(
      `Scheduled recurring reminder for task ${taskId} with frequency ${reminder_frequency}`
    );
    return res.status(200).json({ message: "Recurring reminder scheduled" });
  }
});

// Initialize data and start server
async function main() {
  allData = await getAllTasks();
}

main();
makeTwilioRequest();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
