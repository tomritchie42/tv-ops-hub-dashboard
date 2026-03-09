const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'change-me-to-a-secret';

// ââ Data store ââââââââââââââââââââââââââââââââââââââââââââââ
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'consignments.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readData()  { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function writeData(d){ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââ
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-auth-token');
}

// ââ Parse date (handles d/mm/yyyy and yyyy-mm-dd) ââââââââââ
function parseDate(str) {
  if (!str) return null;
  // Australian dd/mm/yyyy or d/mm/yyyy
  const auMatch = str.match(/^(\d{1,2})\/(\d{2})\/(\d{4})/);
  if (auMatch) return new Date(parseInt(auMatch[3]), parseInt(auMatch[2])-1, parseInt(auMatch[1]));
  // ISO yyyy-mm-dd
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(d1, d2) {
  return Math.round(Math.abs((d2 - d1) / (1000*60*60*24)));
}

function formatDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// ââ Dashboard aggregation âââââââââââââââââââââââââââââââââââ
function aggregateOps(period) {
  const raw = readData();
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - period);

  const cons = raw.filter(c => {
    const d = parseDate(c.ConsignmentDate || c.CreatedDate);
    return d && d >= cutoff;
  });

  if (cons.length === 0) {
    return { empty: true, totalInDB: raw.length, period };
  }

  // ââ Today's snapshot ââ
  const todayStr = formatDate(now);
  const todayCons = cons.filter(c => {
    const d = parseDate(c.ConsignmentDate || c.CreatedDate);
    return d && formatDate(d) === todayStr;
  });

  const statusCount = {};
  cons.forEach(c => {
    const s = (c.Status || 'Unknown').toLowerCase();
    statusCount[s] = (statusCount[s] || 0) + 1;
  });

  const delivered = cons.filter(c => (c.Status||'').toLowerCase().includes('deliver'));
  const inTransit = cons.filter(c => {
    const s = (c.Status||'').toLowerCase();
    return s.includes('transit') || s.includes('pickup') || s.includes('received') || s.includes('dispatched');
  });
  const created = cons.filter(c => (c.Status||'').toLowerCase() === 'created');
  const exceptions = cons.filter(c => {
    const s = (c.Status||'').toLowerCase();
    return s.includes('exception') || s.includes('fail') || s.includes('return') || s.includes('damage') || s.includes('redelivery') || s.includes('carded');
  });

  // ââ DIFOT (Delivered In Full On Time) ââ
  // Approximate: if delivered, check if delivery happened (we'll count delivered as on-time for now)
  const totalWithDeliveryExpected = cons.filter(c => {
    const s = (c.Status||'').toLowerCase();
    return s !== 'created' && s !== 'cancelled';
  });
  const difotRate = totalWithDeliveryExpected.length > 0
    ? Math.round((delivered.length / totalWithDeliveryExpected.length) * 100 * 10) / 10
    : 0;

  // ââ Volume by day (last 14 days) ââ
  const dailyVolume = {};
  const dailyDelivered = {};
  for (let i = 0; i < Math.min(period, 14); i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = formatDate(d);
    dailyVolume[key] = 0;
    dailyDelivered[key] = 0;
  }
  cons.forEach(c => {
    const d = parseDate(c.ConsignmentDate || c.CreatedDate);
    if (!d) return;
    const key = formatDate(d);
    if (dailyVolume.hasOwnProperty(key)) {
      dailyVolume[key]++;
      if ((c.Status||'').toLowerCase().includes('deliver')) dailyDelivered[key]++;
    }
  });
  const dailyTrend = Object.keys(dailyVolume).sort().map(d => ({
    date: d,
    total: dailyVolume[d],
    delivered: dailyDelivered[d]
  }));

  // ââ Volume by headport/hub ââ
  const hubSending = {};
  const hubReceiving = {};
  cons.forEach(c => {
    const sh = c.SendingHeadport || c.SenderSuburb || 'Unknown';
    const rh = c.ReceivingHeadport || c.ReceiverSuburb || 'Unknown';
    hubSending[sh] = (hubSending[sh] || 0) + 1;
    hubReceiving[rh] = (hubReceiving[rh] || 0) + 1;
  });
  const topSendingHubs = Object.entries(hubSending)
    .sort((a,b) => b[1]-a[1]).slice(0,15)
    .map(([hub, count]) => ({ hub, count }));
  const topReceivingHubs = Object.entries(hubReceiving)
    .sort((a,b) => b[1]-a[1]).slice(0,15)
    .map(([hub, count]) => ({ hub, count }));

  // ââ Service level breakdown ââ
  const serviceBreakdown = {};
  cons.forEach(c => {
    const svc = c.ServiceType || c.ServiceLevel || 'Unknown';
    if (!serviceBreakdown[svc]) serviceBreakdown[svc] = { total: 0, delivered: 0, weight: 0, items: 0 };
    serviceBreakdown[svc].total++;
    if ((c.Status||'').toLowerCase().includes('deliver')) serviceBreakdown[svc].delivered++;
    serviceBreakdown[svc].weight += parseFloat(c.Weight) || 0;
    serviceBreakdown[svc].items += parseInt(c.Items) || 0;
  });
  const serviceTypes = Object.entries(serviceBreakdown)
    .sort((a,b) => b[1].total - a[1].total)
    .map(([name, data]) => ({
      name,
      total: data.total,
      delivered: data.delivered,
      deliveryRate: data.total > 0 ? Math.round(data.delivered/data.total*100) : 0,
      weight: Math.round(data.weight),
      items: data.items
    }));

  // ââ Top lanes (origin â destination) ââ
  const lanes = {};
  cons.forEach(c => {
    const from = c.SendingHeadport || c.SenderSuburb || c.SenderState || '?';
    const to = c.ReceivingHeadport || c.ReceiverSuburb || c.ReceiverState || '?';
    const key = from + ' â ' + to;
    if (!lanes[key]) lanes[key] = { count: 0, weight: 0 };
    lanes[key].count++;
    lanes[key].weight += parseFloat(c.Weight) || 0;
  });
  const topLanes = Object.entries(lanes)
    .sort((a,b) => b[1].count - a[1].count).slice(0,20)
    .map(([lane, data]) => ({ lane, count: data.count, weight: Math.round(data.weight) }));

  // ââ Status breakdown for pie chart ââ
  const statusBreakdown = Object.entries(statusCount)
    .sort((a,b) => b[1]-a[1])
    .map(([status, count]) => ({ status, count }));

  // ââ Aging consignments (created but not delivered) ââ
  const aging = { under24h: 0, day1to3: 0, day3to7: 0, over7: 0 };
  const agingList = [];
  cons.forEach(c => {
    const s = (c.Status||'').toLowerCase();
    if (s.includes('deliver') || s === 'cancelled') return;
    const created = parseDate(c.ConsignmentDate || c.CreatedDate);
    if (!created) return;
    const days = daysBetween(created, now);
    if (days < 1) aging.under24h++;
    else if (days <= 3) aging.day1to3++;
    else if (days <= 7) aging.day3to7++;
    else {
      aging.over7++;
      if (agingList.length < 20) {
        agingList.push({
          consignment: c.ConsignmentNumber,
          customer: c.CustomerName || c.SenderName,
          receiver: c.ReceiverName,
          receiverSuburb: c.ReceiverSuburb,
          status: c.Status,
          days: days,
          serviceType: c.ServiceType || c.ServiceLevel,
          date: c.ConsignmentDate || c.CreatedDate
        });
      }
    }
  });
  agingList.sort((a,b) => b.days - a.days);

  // ââ Peak hours / day-of-week ââ
  const dayOfWeek = [0,0,0,0,0,0,0]; // Sun-Sat
  cons.forEach(c => {
    const d = parseDate(c.ConsignmentDate || c.CreatedDate);
    if (d) dayOfWeek[d.getDay()]++;
  });
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const peakDays = dayNames.map((name, i) => ({ day: name, count: dayOfWeek[i] }));

  // ââ Weight & volume metrics ââ
  const totalWeight = cons.reduce((sum, c) => sum + (parseFloat(c.Weight) || 0), 0);
  const totalItems = cons.reduce((sum, c) => sum + (parseInt(c.Items) || 0), 0);
  const totalCubic = cons.reduce((sum, c) => sum + (parseFloat(c.Cubic) || 0), 0);

  // ââ State/zone breakdown ââ
  const zoneData = {};
  cons.forEach(c => {
    const zone = c.ReceiverState || 'Unknown';
    if (!zoneData[zone]) zoneData[zone] = { count: 0, delivered: 0, weight: 0 };
    zoneData[zone].count++;
    if ((c.Status||'').toLowerCase().includes('deliver')) zoneData[zone].delivered++;
    zoneData[zone].weight += parseFloat(c.Weight) || 0;
  });
  const zones = Object.entries(zoneData)
    .sort((a,b) => b[1].count - a[1].count)
    .map(([zone, data]) => ({
      zone,
      consignments: data.count,
      delivered: data.delivered,
      deliveryRate: data.count > 0 ? Math.round(data.delivered/data.count*100) : 0,
      weight: Math.round(data.weight)
    }));

  // ââ Customer volume (operational view - who's sending the most) ââ
  const custVol = {};
  cons.forEach(c => {
    const cust = c.CustomerName || c.SenderName || 'Unknown';
    if (!custVol[cust]) custVol[cust] = { count: 0, delivered: 0, weight: 0 };
    custVol[cust].count++;
    if ((c.Status||'').toLowerCase().includes('deliver')) custVol[cust].delivered++;
    custVol[cust].weight += parseFloat(c.Weight) || 0;
  });
  const topCustomersByVolume = Object.entries(custVol)
    .sort((a,b) => b[1].count - a[1].count).slice(0,20)
    .map(([name, data]) => ({
      name,
      consignments: data.count,
      delivered: data.delivered,
      deliveryRate: data.count > 0 ? Math.round(data.delivered/data.count*100) : 0,
      weight: Math.round(data.weight)
    }));

  // ââ Receiver suburb hotspots (delivery destinations) ââ
  const destData = {};
  cons.forEach(c => {
    const dest = c.ReceiverSuburb || 'Unknown';
    if (!destData[dest]) destData[dest] = { count: 0, delivered: 0 };
    destData[dest].count++;
    if ((c.Status||'').toLowerCase().includes('deliver')) destData[dest].delivered++;
  });
  const topDestinations = Object.entries(destData)
    .sort((a,b) => b[1].count - a[1].count).slice(0,20)
    .map(([suburb, data]) => ({
      suburb,
      consignments: data.count,
      delivered: data.delivered,
      deliveryRate: data.count > 0 ? Math.round(data.delivered/data.count*100) : 0
    }));

  return {
    period,
    totalInDB: raw.length,
    kpis: {
      totalConsignments: cons.length,
      todayConsignments: todayCons.length,
      delivered: delivered.length,
      inTransit: inTransit.length,
      created: created.length,
      exceptions: exceptions.length,
      difotRate,
      totalWeight: Math.round(totalWeight),
      totalItems,
      totalCubic: Math.round(totalCubic * 100) / 100,
      avgWeightPerCon: cons.length > 0 ? Math.round(totalWeight / cons.length * 10) / 10 : 0,
      activeCustomers: new Set(cons.map(c => c.CustomerName || c.SenderName).filter(Boolean)).size
    },
    dailyTrend,
    statusBreakdown,
    serviceTypes,
    topSendingHubs,
    topReceivingHubs,
    topLanes,
    aging,
    agingList,
    peakDays,
    zones,
    topCustomersByVolume,
    topDestinations
  };
}

// ââ Server ââââââââââââââââââââââââââââââââââââââââââââââââââ
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ââ Webhook ââ
  if (pathname === '/api/webhook' && req.method === 'POST') {
    const token = parsed.query.token || req.headers['x-auth-token'] || '';
    if (token !== WEBHOOK_TOKEN) return json(res, { error: 'Unauthorised' }, 401);

    try {
      const body = await readBody(req);
      let consignments = [];
      const ct = req.headers['content-type'] || '';

      if (ct.includes('xml') || body.trim().startsWith('<')) {
        // XML parsing
        const blocks = body.split('<ConsignmentNumber>').slice(1);
        blocks.forEach(block => {
          const get = tag => { const m = block.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 's')); return m ? m[1].trim() : ''; };
          const conNum = block.split('</ConsignmentNumber>')[0]?.trim();
          consignments.push({
            ConsignmentNumber: conNum, ConsignmentDate: get('ConsignmentDate'),
            SenderName: get('SenderName'), SenderAddress: get('SenderAddress'),
            SenderSuburb: get('SenderSuburb'), SenderState: get('SenderState'),
            SenderPostcode: get('SenderPostcode'),
            ReceiverName: get('ReceiverName'), ReceiverAddress: get('ReceiverAddress'),
            ReceiverSuburb: get('ReceiverSuburb'), ReceiverState: get('ReceiverState'),
            ReceiverPostcode: get('ReceiverPostcode'),
            ServiceType: get('ServiceType') || get('ServiceName'),
            Status: get('Status') || get('StatusName'),
            Revenue: parseFloat(get('Revenue') || get('TotalCharge')) || 0,
            Weight: parseFloat(get('Weight') || get('TotalWeight')) || 0,
            Cubic: parseFloat(get('Cubic') || get('TotalCubic')) || 0,
            Items: parseInt(get('Items') || get('TotalItems')) || 0,
            DeliveryDate: get('DeliveryDate'), CreatedDate: get('CreatedDate'),
            CustomerName: get('CustomerName') || get('SenderName'),
            SendingHeadport: get('SendingHeadport'), ReceivingHeadport: get('ReceivingHeadport'),
            SenderReference: get('SenderReference'), ReceiverReference: get('ReceiverReference'),
            SpecialInstructions: get('SpecialInstructions')
          });
        });
      } else {
        const parsed = JSON.parse(body);
        if (parsed.consignments) consignments = parsed.consignments;
        else if (Array.isArray(parsed)) consignments = parsed;
        else if (parsed.ConsignmentNumber) consignments = [parsed];
      }

      const existing = readData();
      const map = new Map(existing.map(c => [c.ConsignmentNumber, c]));
      consignments.forEach(c => { c._receivedAt = new Date().toISOString(); map.set(c.ConsignmentNumber, c); });
      writeData(Array.from(map.values()));

      console.log('[WEBHOOK] Received ' + consignments.length + ' consignment(s) - total: ' + map.size);
      return json(res, { success: true, received: consignments.length, total: map.size });
    } catch (err) {
      console.error('[WEBHOOK] Error:', err.message);
      return json(res, { error: err.message }, 400);
    }
  }

  // ââ Dashboard API ââ
  if (pathname === '/api/dashboard' && req.method === 'GET') {
    const period = parseInt(parsed.query.period) || 30;
    return json(res, aggregateOps(period));
  }

  // ââ Stats ââ
  if (pathname === '/api/stats' && req.method === 'GET') {
    const raw = readData();
    return json(res, {
      totalConsignments: raw.length,
      uniqueCustomers: new Set(raw.map(c => c.SenderName || c.CustomerName).filter(Boolean)).size,
      oldestRecord: raw.length > 0 ? raw.reduce((min, c) => (c.ConsignmentDate||'') < min ? (c.ConsignmentDate||'') : min, raw[0].ConsignmentDate||'') : null,
      newestRecord: raw.length > 0 ? raw.reduce((max, c) => (c.ConsignmentDate||'') > max ? (c.ConsignmentDate||'') : max, raw[0].ConsignmentDate||'') : null
    });
  }

  // ââ CSV Import ââ
  if (pathname === '/api/import-csv' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const lines = body.split('\n').filter(l => l.trim());
      if (lines.length < 2) return json(res, { error: 'No data rows' }, 400);
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      const existing = readData();
      const map = new Map(existing.map(c => [c.ConsignmentNumber, c]));
      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
        const row = {}; headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        const c = {
          ConsignmentNumber: row.ConsignmentNumber || row.Connote || row['Con Note'] || 'IMPORT-' + i,
          ConsignmentDate: row.ConsignmentDate || row.Date || row['Created Date'] || '',
          SenderName: row.SenderName || row.Sender || row.Customer || row.Account || '',
          SenderSuburb: row.SenderSuburb || row['Sender Suburb'] || '',
          SenderState: row.SenderState || row['Sender State'] || '',
          ReceiverName: row.ReceiverName || row.Receiver || '',
          ReceiverSuburb: row.ReceiverSuburb || row['Receiver Suburb'] || '',
          ReceiverState: row.ReceiverState || row['Receiver State'] || '',
          ServiceType: row.ServiceType || row['Service Level'] || row.Service || '',
          Status: row.Status || row.StatusName || '',
          Revenue: parseFloat(row.Revenue || row['Total Charge'] || row.Charge || 0) || 0,
          Weight: parseFloat(row.Weight || row['Total Weight'] || 0) || 0,
          Cubic: parseFloat(row.Cubic || row['Total Cubic'] || 0) || 0,
          Items: parseInt(row.Items || row.Qty || row['Total Items'] || 0) || 0,
          CustomerName: row.CustomerName || row['Customer Name'] || row.SenderName || row.Sender || '',
          SendingHeadport: row.SendingHeadport || row['Sending Headport'] || '',
          ReceivingHeadport: row.ReceivingHeadport || row['Receiving Headport'] || '',
          _receivedAt: new Date().toISOString()
        };
        map.set(c.ConsignmentNumber, c);
        imported++;
      }
      writeData(Array.from(map.values()));
      return json(res, { success: true, imported, total: map.size });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ââ Static files ââ
  let filePath = pathname === '/' ? '/public/index.html' : '/public' + pathname;
  filePath = path.join(__dirname, filePath);
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log('Ops Hub Dashboard running on port ' + PORT));
