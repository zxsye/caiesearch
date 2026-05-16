const mongoose = require('mongoose');
const sspdf = require('../lib/sspdf.js');
const Recognizer = require('../lib/recognizer.js');
const { MONGODB } = process.env;
const DB_URI = MONGODB || 'mongodb://mw-mongo/schsrch';

async function run() {
  const db = mongoose.createConnection(DB_URI);
  const { PastPaperDoc } = await require('../lib/dbModel.js')(db, { indices: { create: () => Promise.resolve() } });

  const years = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  const subject = '9701';

  console.log(`Fidelity Test for Subject ${subject} across years 2015-2025\n`);
  console.log('Year | Paper ID | Name | Questions Found');
  console.log('-----|----------|------|----------------');

  for (const yr of years) {
    const yrStr = yr.toString().padStart(2, '0');
    // Find a random QP for this year using regex on the time field
    const docs = await PastPaperDoc.find({ subject, type: 'qp', time: new RegExp(yrStr + '$') }).limit(5);
    if (docs.length === 0) {
      console.log(`${yr} | N/A      | No papers found`);
      continue;
    }
    
    // Pick a random one from the 5
    const doc = docs[Math.floor(Math.random() * docs.length)];
    const name = `${doc.subject}_${doc.time}_qp_${doc.paper}${doc.variant}`;

    try {
      const blob = await doc.getFileBlob();
      const pageDatas = await sspdf.getPDFContentAll(blob);
      const recognizerArg = [];
      for (let p = 0; p < pageDatas.numPages; p++) {
        recognizerArg[p] = {
          rects: pageDatas.pageRects[p],
          content: pageDatas.pageTexts[p],
          page: p
        };
      }
      const dir = Recognizer.dir(recognizerArg);
      const qCount = dir.dirs ? dir.dirs.length : 0;
      const qList = dir.dirs ? dir.dirs.map(d => d.qN).join(',') : '';

      console.log(`${yr} | ${doc._id} | ${name} | ${qCount} (${qList})`);
    } catch (e) {
      console.log(`${yr} | ${doc._id} | ${name} | ERROR: ${e.message}`);
    }
  }

  process.exit(0);
}

run();
