/**
 * Dump every data channel's physical values as raw float64, for comparison with pyEDFlib.
 *
 * The comparison has to happen on doubles rather than on CSV text. A CSV cell is a rounded
 * decimal rendering, so reading one back gives the nearest double to the printed digits and
 * not the double that was computed — which turns an exact check into a tolerance check, and
 * any tolerance loose enough to pass hides every error smaller than itself.
 *
 * This is the recipe from the correctness page, checked in so the documented method and the
 * one that actually runs are the same code. It uses only the public API.
 *
 *     node test/crossvalidate/dump-doubles.mjs <recording> <output-directory>
 *
 * One file per data channel, named `<index>.f64`, holding little-endian doubles in sample
 * order, plus `channels.json` naming them. Annotation channels carry text, not signal, and
 * are skipped — they are compared separately, through annotations.csv.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EdfFile, makeScaler } from '../../dist/index.js';

const [input, outputDir] = process.argv.slice(2);
if (!input || !outputDir) {
  process.stderr.write('usage: dump-doubles.mjs <recording> <output-directory>\n');
  process.exit(2);
}

const file = await EdfFile.open(input);
try {
  mkdirSync(outputDir, { recursive: true });

  const channels = file.dataSignals;
  const values = channels.map((signal) => new Float64Array(signal.samplesPerRecord * file.recordCount));
  const written = channels.map(() => 0);

  for await (const batch of file.readRecords()) {
    for (let record = 0; record < batch.recordCount; record++) {
      for (const [channel, signal] of channels.entries()) {
        const scale = makeScaler(signal);
        const into = values[channel];
        for (let i = 0; i < signal.samplesPerRecord; i++) {
          into[written[channel]++] = scale(file.sampleAt(batch, record, signal, i));
        }
      }
    }
  }

  for (const [channel, signal] of channels.entries()) {
    const filled = values[channel].subarray(0, written[channel]);
    writeFileSync(path.join(outputDir, `${channel}.f64`), Buffer.from(filled.buffer, filled.byteOffset, filled.byteLength));
  }

  writeFileSync(
    path.join(outputDir, 'channels.json'),
    JSON.stringify(
      channels.map((signal, channel) => ({
        file: `${channel}.f64`,
        index: signal.index,
        label: signal.label,
        samples: written[channel],
      })),
      null,
      2,
    ) + '\n',
  );
} finally {
  await file.close();
}
