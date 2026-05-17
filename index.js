import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// eslint-disable-next-line no-undef
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Create temp directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Configure multer
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + '-' + file.originalname);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files allowed'), false);
  }
});

// Convert cues to SRT format
function convertToSRT(cues) {
  const formatTime = (seconds) => {
    const date = new Date(0);
    date.setMilliseconds(seconds * 1000);
    const hours = date.toISOString().substr(11, 8);
    const milliseconds = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
    return `${hours},${milliseconds}`;
  };

  return cues.map((cue, index) => `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}\n`).join('\n');
}

app.post('/api/render-subtitles', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });
    
    const { subtitles, style } = req.body;
    if (!subtitles || !Array.isArray(subtitles)) {
      return res.status(400).json({ error: 'Subtitles required' });
    }

    console.log(`Processing: ${req.file.filename}, ${subtitles.length} subtitles`);

    const inputPath = req.file.path;
    const outputFilename = `processed-${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    const srtPath = path.join(UPLOADS_DIR, `subtitles-${Date.now()}.srt`);

    // Write SRT file
    fs.writeFileSync(srtPath, convertToSRT(subtitles), 'utf8');

    // Style defaults
    const fontSize = style?.fontSize || 24;
    const fontColor = style?.color || '#ffffff';
    const position = style?.position || 'bottom';

    // Calculate Y position
    let yPos = 'h-th-10';
    if (position === 'middle') yPos = 'h/2-th/2';
    else if (position === 'top') yPos = '10';
    else if (position === 'upper-middle') yPos = 'h*0.35-th/2';

    // Process with FFmpeg - convert MOV to MP4, burn subtitles, preserve audio
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions(['-i', srtPath.replace(/:/g, '\\:')])
        .videoCodec('libx264')
        .videoBitrate('2500k')
        .audioCodec('aac')
        .audioBitrate('192k')
        .audioChannels(2)
        .format('mp4')
        .videoFilters([{
          filter: 'subtitles',
          options: {
            filename: srtPath.replace(/:/g, '\\:'),
            force_style: `FontName=Arial,FontSize=${fontSize},PrimaryColour=&H${fontColor.replace('#', '')},BackColour=&H00000099,Bold=1,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=10`
          }
        }])
        .save(outputPath)
        .on('end', () => resolve())
        .on('error', reject);
    });

    // Read and return video
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(srtPath);
    fs.unlinkSync(outputPath);

    res.json({
      success: true,
      video: videoBase64,
      mimeType: 'video/mp4',
      filename: outputFilename
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'subtitle-renderer' });
});

app.listen(PORT, () => {
  console.log(`Subtitle renderer running on port ${PORT}`);
});