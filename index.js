import cors from "cors"
import dotenv from "dotenv"
import express from "express"
import { promises as fsPromises } from "fs"
import fs from "fs"
import Groq from "groq-sdk"
import { exec } from "child_process"
import ffmpeg from "@ffmpeg-installer/ffmpeg"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import axios from "axios"
import crypto from "crypto"

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const groq = new Groq({
  apiKey: "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", // Use environment variables for secur
})

const voiceRSSApiKey = "b30d60adb1d4469f913533e80b11701f" // Replace with your VoiceRSS API key

const app = express()
app.use(express.json())
app.use(cors())
const port = 4000

// Audio cache
const audioCache = new Map()

app.get("/", (req, res) => {
  res.send("Hello World!")
})

const convertToWav = async (inputFile, outputFile) => {
  return new Promise((resolve, reject) => {
    exec(`${ffmpeg.path} -y -i ${inputFile} -ar 16000 -ac 1 ${outputFile}`, (error) => {
      if (error) {
        console.error("FFmpeg error:", error)
        return reject(error)
      }
      console.log(`Converted ${inputFile} to ${outputFile}`)
      resolve()
    })
  })
}

const generateLipSync = async (wavFile, outputJson) => {
  return new Promise((resolve, reject) => {
    let rhubarbPath = "./bin/rhubarb" // Default for Linux/Mac
    if (os.platform() === "win32") {
      rhubarbPath = path.join(__dirname, "bin", "rhubarb.exe") // Use .exe on Windows
    }

    const command = `"${rhubarbPath}" -f json -o "${outputJson}" "${wavFile}" -r phonetic`

    exec(command, (error) => {
      if (error) {
        console.error("Rhubarb error:", error)
        return reject(error)
      }
      console.log(`Lip sync JSON generated: ${outputJson}`)
      resolve()
    })
  })
}

const generateAudio = async (text, outputFile) => {
  const cacheKey = crypto.createHash("md5").update(text).digest("hex")

  if (audioCache.has(cacheKey)) {
    await fsPromises.copyFile(audioCache.get(cacheKey), outputFile)
    return
  }

  // Using 'en-us' (American English) with 'Amy' voice, and increased speech rate
  const url = `http://api.voicerss.org/?key=${voiceRSSApiKey}&hl=en-us&v=Amy&r=0&c=MP3&f=44khz_16bit_stereo&src=${encodeURIComponent(text)}`

  const response = await axios({
    method: "get",
    url: url,
    responseType: "stream",
  })

  const writer = fs.createWriteStream(outputFile)
  response.data.pipe(writer)

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve)
    writer.on("error", reject)
  })

  audioCache.set(cacheKey, outputFile)
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message
    if (!userMessage) {
      res.send({
        messages: [
          {
            text: "Hello! I'm your coding tutor. What programming topic would you like to learn about?",
            audio: await audioFileToBase64("audios/intro_0.wav"),
            lipsync: await readJsonTranscript("audios/intro_0.json"),
            facialExpression: "smile",
            animation: "Talking_1",
          },
        ],
        tutorResponse: null,
      })
      return
    }

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",  
          content: `
          You are a virtual programming tutor with expertise in multiple programming languages and software development concepts.
          Your responses must be in plain JSON format without any markdown formatting or code blocks.
          Return a JSON object with exactly this structure:
          {
            "messages": [
              {
                "text": "Brief introduction to the topic",
                "facialExpression": "smile",
                "animation": "Talking_1"
              }
            ],
            "tutorResponse": {
              "topic": "Main topic",
              "explanation": "Detailed explanation of the topic",
              "infographic": "URL to a relevant infographic or diagram",
              "resources": [
                {
                  "title": "Resource title",
                  "url": "Resource URL"
                }
              ]
            }
          }
          
          DO NOT include any explanatory text or code blocks around the JSON. Return ONLY the JSON object.
          `,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.8,
    })

    // Get the content and debug it
    const rawContent = completion.choices[0].message.content
    
    // Handle different ways the model might format the response
    let jsonStr = rawContent
      .replace(/```json\n?/g, '') // Remove ```json
      .replace(/```\n?/g, '')     // Remove ```
      .trim()
    
    // Try to find JSON object in the content if it's embedded in text
    const jsonMatch = jsonStr.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    
    console.log("Attempting to parse:", jsonStr.substring(0, 100) + "..."); // Debug first 100 chars
    
    // Try to parse the JSON
    let response;
    try {
      response = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      
      // Create a fallback response
      response = {
        messages: [
          {
            text: "I'm sorry, I encountered an issue processing your request. Let me provide a simple response instead.",
            facialExpression: "neutral",
            animation: "Talking_1"
          }
        ],
        tutorResponse: {
          topic: "Response Error",
          explanation: "I received your question about: " + userMessage.substring(0, 100) + "... but had trouble formatting my response. Let me know if you'd like to try again.",
          resources: []
        }
      };
    }

    // Process audio for each message
    for (let i = 0; i < response.messages.length; i++) {
      const message = response.messages[i]
      const fileNameMp3 = `audios/message_${i}.mp3`
      const fileNameWav = `audios/message_${i}.wav`
      const fileNameJson = `audios/message_${i}.json`
      const textInput = message.text

      await generateAudio(textInput, fileNameMp3)
      await convertToWav(fileNameMp3, fileNameWav)
      await generateLipSync(fileNameWav, fileNameJson)

      message.audio = await audioFileToBase64(fileNameWav)
      message.lipsync = await readJsonTranscript(fileNameJson)
    }

    res.send(response)
  } catch (error) {
    console.error("Error in /chat endpoint:", error);
    
    // Send a failsafe response
    res.status(500).send({
      messages: [
        {
          text: "I apologize, but I encountered a technical issue. Please try again with your question.",
          facialExpression: "sad",
          animation: "Talking_1"
        }
      ],
      tutorResponse: {
        topic: "Error Occurred",
        explanation: "There was a technical issue processing your request.",
        resources: []
      }
    });
  }
})

const readJsonTranscript = async (file) => {
  try {
    const data = await fsPromises.readFile(file, "utf8")
    return JSON.parse(data)
  } catch (error) {
    console.error(`Error reading or parsing ${file}:`, error)
    // Return empty object as fallback
    return {}
  }
}

const audioFileToBase64 = async (file) => {
  try {
    const data = await fsPromises.readFile(file)
    return data.toString("base64")
  } catch (error) {
    console.error(`Error reading audio file ${file}:`, error)
    // Return empty string as fallback
    return ""
  }
}

app.listen(port, () => {
  console.log(`Virtual Tutor listening on port ${port}`)
})