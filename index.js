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
        Provide a structured JSON response with the following format:
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
        
        Keep your responses educational, encouraging, and professional. Provide accurate and up-to-date information about programming concepts, best practices, and technologies.
        `,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
    model: "mixtral-8x7b-32768",
    temperature: 0.8, // Increased from 0.6 to 0.8 for faster responses
  })

  const response = JSON.parse(completion.choices[0].message.content)

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
})

const readJsonTranscript = async (file) => {
  const data = await fsPromises.readFile(file, "utf8")
  return JSON.parse(data)
}

const audioFileToBase64 = async (file) => {
  const data = await fsPromises.readFile(file)
  return data.toString("base64")
}

app.listen(port, () => {
  console.log(`Virtual Tutor listening on port ${port}`)
})

