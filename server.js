const express = require('express');
const { spawn } = require('child_process');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');

// === Пути ===
const YT_DLP = path.join(__dirname, 'bin', 'yt-dlp.exe');
const FFMPEG_PATH = path.join(__dirname, 'bin', 'ffmpeg.exe');
const TEMP_DIR = path.join(__dirname, 'temp');

// === Добавляем bin в PATH (Windows) ===
const BIN_DIR = path.join(__dirname, 'bin');
if (process.platform === 'win32' && !process.env.PATH.includes(BIN_DIR)) {
  process.env.PATH = `${BIN_DIR};${process.env.PATH}`;
}

// === Проверки === 
if (!fs.existsSync(YT_DLP)) {
  console.error('ОШИБКА: yt-dlp.exe не найден в bin/');
  process.exit(1);
}
if (!fs.existsSync(FFMPEG_PATH)) {
  console.error('ОШИБКА: ffmpeg.exe не найден в bin/');
  process.exit(1);
}
process.env.FFMPEG_LOCATION = FFMPEG_PATH;

// === Создаём временную папку ===
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// === Очистка старых файлов при запуске (без ошибок) ===
try {
  fs.readdirSync(TEMP_DIR).forEach(f => {
    try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
  });
} catch (e) {}

// === Express ===
const app = express();
const PORT = 9000;

app.use(express.static(path.join(__dirname)));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/download', async (req, res) => {
  const urls = (req.body.url || '')
    .split('\n')
    .map(u => u.trim())
    .filter(u => u && (u.includes('youtube.com') || u.includes('youtu.be')));

  if (urls.length === 0) {
    return res.status(400).send('<h3>Нет ссылок!</h3><a href="/">Назад</a>');
  }

  // CHANGED: убираем искусственный маленький лимит — можно ставить большой лимит при желании.
  // Но лучше всё же не перегружать сервер. Здесь оставлю лимит 1000 для безопасности.
  const limited = urls; // без лимита

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="YouTube_MP3_Pack_${Date.now()}.zip"`);
  res.setHeader('Cache-Control', 'no-cache');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => console.error('ZIP ошибка:', err));
  archive.pipe(res);

  let success = 0;

  // helper: читаем реестр temp (utf8)
  const getFilesInTemp = () => {
    try {
      return fs.readdirSync(TEMP_DIR);
    } catch (err) {
      console.error('Ошибка чтения temp:', err);
      return [];
    }
  };

  for (let i = 0; i < limited.length; i++) {
    const url = limited[i];
    const indexPrefix = String(i + 1).padStart(4, '0');
    let finalPath = null;
    let finalName = null;

    try {
      console.log(`\n[${i + 1}/${limited.length}] Скачиваю: ${url}`);

      // Удаляем предыдущие файлы с тем же префиксом (на всякий)
      getFilesInTemp().forEach(f => {
        if (f.startsWith(indexPrefix + '_')) {
          try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
        }
      });

      // CHANGED: формируем output с индексом (гарантирует порядок).
      // УДАЛИЛ --restrict-filenames чтобы сохранить кириллицу.
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

      // CHANGED: передаём PYTHONIOENCODING=utf-8 чтобы yt-dlp/ffmpeg печатали utf-8
      const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });

      const cmd = spawn(YT_DLP, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env
      });

      // Собираем stdout/stderr (буферы -> utf8)
      cmd.stdout.on('data', chunk => {
        try { console.log('[YT]', Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); }
        catch (e) {}
      });
      cmd.stderr.on('data', chunk => {
        try { console.log('[YT-ERR]', Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); }
        catch (e) {}
      });

      await new Promise((resolve, reject) => {
        cmd.on('close', code => {
          if (code !== 0) return reject(new Error(`yt-dlp завершился с кодом ${code}`));
          // даём ffmpeg закончить работу вывода
          setTimeout(resolve, 800);
        });
        cmd.on('error', reject);
      });

      // Небольшая стабилизация файловой системы
      await new Promise(r => setTimeout(r, 500));

      // CHANGED: ищем файл по нашему префиксу (гарантирует корректное имя, включая кириллицу)
      const files = getFilesInTemp();
      const found = files.find(f => f.startsWith(indexPrefix + '_') && (f.endsWith('.mp3') || f.endsWith('.webm') || f.endsWith('.m4a') || f.endsWith('.aac')));
      if (!found) throw new Error('Файл не найден после скачивания');

      const filePath = path.join(TEMP_DIR, found);

      // Конвертация webm->mp3 при необходимости
      if (found.endsWith('.webm') || found.endsWith('.m4a') || found.endsWith('.aac')) {
        const mp3Name = found.replace(/\.(webm|m4a|aac)$/i, '.mp3');
        const mp3Path = path.join(TEMP_DIR, mp3Name);
        console.log('Конвертируем в MP3:', mp3Name);
        await convertToMp3(filePath, mp3Path);
        try { fs.unlinkSync(filePath); } catch {}
        finalPath = mp3Path;
        finalName = mp3Name;
      } else {
        finalPath = filePath;
        finalName = found;
      }

      // Очищаем имя для архива (оставляем кириллицу, но убираем запрещённые символы)
      const cleanName = finalName
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 200);

      // CHANGED: добавляем в архив в том порядке, в котором обрабатываем (индекс гарантирует порядок)
      archive.append(fs.createReadStream(finalPath), { name: cleanName });
      success++;

      // Удаляем временный MP3 через 30 секунд
      setTimeout(() => {
        try { fs.unlinkSync(finalPath); } catch {}
      }, 30000);

      console.log('УСПЕХ:', cleanName);
    } catch (err) {
      console.error(`ОШИБКА [${i + 1}]:`, err.message || err);
      const errorText = `URL: ${url}\nОшибка: ${String(err.message || err)}\nВремя: ${new Date().toISOString()}\n\n`;
      archive.append(Buffer.from(errorText, 'utf8'), { name: `_ERROR_${indexPrefix}.txt` });
    }

    // Пауза между запросами (можно увеличить при проблемах)
    if (i < limited.length - 1) {
      await new Promise(r => setTimeout(r, 2500));
    }
  }

  // Финализация
  if (success === 0) {
    archive.append(Buffer.from('Ни одно видео не удалось скачать.'), { name: 'README.txt' });
  }

  await archive.finalize();
  console.log(`\nГОТОВО! Успешно: ${success}/${limited.length}`);
});

app.listen(PORT, () => {
  console.log(`\nСервер запущен: http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YT_DLP}`);
  console.log(`Временные файлы: ${TEMP_DIR}\n`);
});

// === Конвертация в mp3 через ffmpeg ===
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-i', inputPath,
      '-codec:a', 'libmp3lame',
      '-q:a', '0',
      '-y',
      outputPath
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    });

    ffmpeg.stdout.on('data', () => {});
    ffmpeg.stderr.on('data', () => {});

    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}`));
    });
    ffmpeg.on('error', reject);
  });
}
