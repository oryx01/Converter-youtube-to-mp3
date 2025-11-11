const express = require('express');
const { spawn } = require('child_process');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

// === Пути ===
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';  // просто команда
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const TEMP_DIR = path.join(__dirname, 'temp');

// === Создаём временную папку ===
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// === Express ===
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/download', async (req, res) => {
  const urls = (req.body.url || '')
    .split('\n')
    .map(u => u.trim())
    .filter(u => u && (u.includes('youtube.com') || u.includes('youtu.be')));

  if (urls.length === 0) {
    return res.status(400).send('<h3>Нет ссылок!</h3><a href="/">Назад</a>');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="YouTube_MP3_Pack_${Date.now()}.zip"`);
  res.setHeader('Cache-Control', 'no-cache');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => console.error('ZIP ошибка:', err));
  archive.pipe(res);

  let success = 0;

  const getFilesInTemp = () => {
    try {
      return fs.readdirSync(TEMP_DIR);
    } catch (err) {
      console.error('Ошибка чтения temp:', err);
      return [];
    }
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const indexPrefix = String(i + 1).padStart(4, '0');

    try {
      console.log(`\n[${i + 1}/${urls.length}] Скачиваю: ${url}`);

      const outputTemplate = path.join(TEMP_DIR, `${indexPrefix}_%(title)s.%(ext)s`);
      const args = [
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--no-playlist',
        '--output', outputTemplate,
        '--newline',
        url
      ];

      const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
      const cmd = spawn(YT_DLP, args, { env });

      cmd.stdout.on('data', data => console.log(data.toString()));
      cmd.stderr.on('data', data => console.log(data.toString()));

      await new Promise((resolve, reject) => {
        cmd.on('close', code => (code === 0 ? resolve() : reject(new Error(`yt-dlp завершился с кодом ${code}`))));
        cmd.on('error', reject);
      });

      const files = getFilesInTemp();
      const found = files.find(f => f.startsWith(indexPrefix + '_') && f.endsWith('.mp3'));
      if (!found) throw new Error('Файл не найден после скачивания');

      const filePath = path.join(TEMP_DIR, found);
      const cleanName = found.replace(/[<>:"/\\|?*]/g, '_').trim();

      archive.append(fs.createReadStream(filePath), { name: cleanName });
      success++;

      // Удаляем файл после добавления
      setTimeout(() => fs.unlink(filePath, () => {}), 30000);

      console.log('УСПЕХ:', cleanName);
    } catch (err) {
      console.error(`ОШИБКА [${i + 1}]:`, err.message);
      archive.append(Buffer.from(`Ошибка: ${err.message}`), { name: `_ERROR_${indexPrefix}.txt` });
    }

    if (i < urls.length - 1) await new Promise(r => setTimeout(r, 2500));
  }

  if (success === 0) {
    archive.append(Buffer.from('Ни одно видео не удалось скачать.'), { name: 'README.txt' });
  }

  await archive.finalize();
  console.log(`\nГОТОВО! Успешно: ${success}/${urls.length}`);
});

app.listen(PORT, () => {
  console.log(`\nСервер запущен: http://localhost:${PORT}`);
});
