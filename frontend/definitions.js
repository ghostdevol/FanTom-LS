'use strict';
/* ============================================================
   GhostTech FanTom — ROM definition engine
   Clean-room implementation. Two definition formats:

   1) NisROM-style XML (EcuFlash-derived) — Nissan:
     <rom base="A2L">
       <romid>
         <xmlid>AL902</xmlid>
         <internalidaddress>6BF9</internalidaddress>
         <internalidstring>AL902</internalidstring>
         ...
   A ROM dump is matched by reading the internal ID string at
   <internalidaddress>. Tables usually come from the base
   definition via inheritance.

   2) XDF (TunerPro) — GM:
     <XDFFORMAT version="1.50">
       <XDFHEADER>
         <deftitle>...</deftitle>
         <BASEOFFSET>0</BASEOFFSET>
         <CATEGORY index="0" name="..."/>
       </XDFHEADER>
       <XDFTABLE uniqueid="0x..." flags="0x30">
         <title>Spark Advance</title>
         <description>...</description>
         <CATEGORYMEM index="0" category="0"/>
         <XDFAXIS id="x" uniqueid="...">
           <EMBEDDEDDATA mmedaddress="0x1C234" mmedelementsizebits="16"
                         mmedrowcount="1" mmedcolcount="16" .../>
           <units>RPM</units>
           <indexcount>16</indexcount>
           <MATH equation="31.25 * X"><VAR id="X"/></MATH>
           <LABEL index="0" value="400"/>
         </XDFAXIS>
         <XDFAXIS id="y" .../>   <!-- rows -->
         <XDFAXIS id="z" .../>   <!-- the actual table data -->
       </XDFTABLE>
     </XDFFORMAT>

   XDF tables are converted to the same internal table shape the
   Nissan path uses (name/type/storagetype/sizex/sizey/address/
   scaling/axes/endian), so the table readers below work unchanged.
   GM data is little-endian; XDF tables carry endian 'Little'.
   Addresses are absolute file offsets: mmedaddress + BASEOFFSET.
   ============================================================ */

const Defs = (() => {
    const registry = new Map(); // xmlid -> parsed definition

    // ---- tiny XML helpers (fixed flat schema; not a general parser) ----
    function tag(xml, name) {
        const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
        return m ? m[1].trim() : '';
    }
    function attr(tagText, name) {
        const m = tagText.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
        return m ? m[1] : '';
    }
    // hex like "0x408" or bare "6BF9" -> int
    function hex(v) {
        if (v == null) return NaN;
        v = String(v).trim();
        if (!v) return NaN;
        return parseInt(/^0x/i.test(v) ? v : '0x' + v, 16);
    }
    function parseFilesize(v) {
        const m = /(\d+)\s*kb/i.exec(v || '');
        return m ? parseInt(m[1], 10) * 1024 : NaN;
    }

    // ---- definition parsing ----
    function parseDefinition(xmlText) {
        const romOpen = (xmlText.match(/<rom\b([^>]*)>/i) || [])[1] || '';
        const romidXml = (xmlText.match(/<romid>([\s\S]*?)<\/romid>/i) || [])[1] || '';
        const checksums = [...xmlText.matchAll(/<checksum\b([^>]*?)\/>/gi)].map(m => ({
            type: attr(m[1], 'type'),
            start: hex(attr(m[1], 'start')),
            end: hex(attr(m[1], 'end')),
            sumloc: hex(attr(m[1], 'sumloc')),
            xorloc: hex(attr(m[1], 'xorloc')),
        }));
        const romid = {};
        ['xmlid', 'caseid', 'internalidaddress', 'internalidstring', 'ecuid',
         'year', 'market', 'make', 'model', 'submodel', 'transmission',
         'memmodel', 'endian', 'flashmethod', 'filesize', 'author', 'version'
        ].forEach(k => { romid[k] = tag(romidXml, k); });
        return {
            base: attr(romOpen, 'base'),
            romid: {
                ...romid,
                internalidaddress: hex(romid.internalidaddress),
                filesizeBytes: parseFilesize(romid.filesize),
            },
            checksums,
            tables: [], // TODO: table schema (base definition / RomTable)
            raw: xmlText,
        };
    }

    function register(xmlText, fileName) {
        if (isXdf(xmlText)) {
            const def = parseXdf(xmlText, fileName);
            try { registerScalings(xmlText); } catch (e) { /* XDFs rarely use scalingbase */ }
            registry.set(def.id, def);
            return def;
        }
        const def = parseDefinition(xmlText);
        if (!def.romid.xmlid) throw new Error('definition has no <xmlid>');
        try { def.tables = parseTables(xmlText); } catch (e) { def.tables = []; }
        registry.set(def.romid.xmlid, def);
        return def;
    }

    // ---- ROM <-> definition matching ----
    function matchRom(romBytes) {
        const bytes = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
        for (const def of registry.values()) {
            const addr = def.romid.internalidaddress;
            const id = def.romid.internalidstring;
            if (!id || Number.isNaN(addr) || addr + id.length > bytes.length) continue;
            let s = '';
            for (let i = 0; i < id.length; i++) s += String.fromCharCode(bytes[addr + i]);
            if (s === id) return def;
        }
        return null;
    }

    // ---- base-definition inheritance (child overrides parent) ----
    function resolveBase(def) {
        if (!def || !def.base) return def;
        const parent = registry.get(def.base);
        if (!parent) return def; // base not loaded — use child as-is
        const merged = resolveBase(parent);
        // Tables merge by name, FIELD-wise: a ROM file's stub table
        // (<table name="..." storageaddress="0x..."/>) inherits every
        // attribute it doesn't explicitly set from the base template.
        const byName = new Map();
        merged.tables.forEach(t => byName.set(t.name, t));
        def.tables.forEach(t => {
            const base = byName.get(t.name);
            byName.set(t.name, base ? mergeTable(base, t) : t);
        });
        return {
            base: def.base,
            romid: { ...merged.romid, ...def.romid },
            checksums: def.checksums.length ? def.checksums : merged.checksums,
            tables: [...byName.values()],
            raw: def.raw,
        };
    }

    function mergeTable(baseT, childT) {
        const ex = childT.explicit || new Set();
        const hasAttr = (...names) => names.some(n => ex.has(n.toLowerCase()));
        const m = { ...baseT, name: childT.name || baseT.name, explicit: ex };
        if (hasAttr('type')) m.type = childT.type;
        if (hasAttr('category')) m.category = childT.category;
        if (hasAttr('storagetype')) m.storagetype = childT.storagetype;
        if (hasAttr('sizex')) m.sizex = childT.sizex;
        if (hasAttr('sizey')) m.sizey = childT.sizey;
        if (hasAttr('userlevel')) m.userlevel = childT.userlevel;
        if (hasAttr('storageaddress', 'address')) {
            m.storageAddress = childT.storageAddress;
            m.address = childT.address;
        }
        if (hasAttr('endian')) m.endian = childT.endian;
        if (childT.scaling) m.scaling = childT.scaling;
        if (childT.axes && childT.axes.length) {
            // Axes merge by TYPE: the ROM stub's axes carry storageaddress,
            // the base template's axes carry names/values/scaling.
            const baseByType = new Map((baseT.axes || []).map(a => [a.type, a]));
            m.axes = childT.axes.map(ca => {
                const ba = baseByType.get(ca.type);
                return ba ? mergeAxis(ba, ca) : ca;
            });
            for (const ba of (baseT.axes || [])) {
                if (!m.axes.some(a => a.type === ba.type)) m.axes.push(ba);
            }
            const findAx = (re) => m.axes.find(ax => re.test(ax.type)) || null;
            m.xAxis = findAx(/x\s*axis/i);
            m.yAxis = findAx(/y\s*axis/i);
        }
        if (childT.description) m.description = childT.description;
        if (childT.symbol) m.symbol = childT.symbol;
        return m;
    }

    function mergeAxis(baseA, childA) {
        const ex = childA.explicit || new Set();
        const hasAttr = (...names) => names.some(n => ex.has(n.toLowerCase()));
        const m = { ...baseA, explicit: ex };
        if (childA.name) m.name = childA.name;
        if (hasAttr('sizex')) m.size = childA.size;
        if (hasAttr('storagetype')) m.storagetype = childA.storagetype;
        if (hasAttr('endian')) m.endian = childA.endian;
        if (hasAttr('storageaddress', 'address')) {
            m.storageAddress = childA.storageAddress;
            m.address = childA.address;
        }
        if (childA.scaling) m.scaling = childA.scaling;
        if (childA.values && childA.values.length) m.values = childA.values;
        return m;
    }

    // ---- tables ----
    // Schema (RomRaider-derived, as used by the A2L template + ROM files):
    //   <table type="2D"|"3D" name="..." category="a//b//c"
    //          storagetype="uint8"|"uint16" sizex="8" [sizey="8"] userlevel="1">
    //     <scaling base="<scalingbase name>"/>
    //     <table type="Static X Axis" name="..." sizex="8">
    //       <data>0</data> ...
    //     </table>
    //     <description><!--symbol-->text</description>
    //   </table>
    // ROM files (<rom base="A2L">) carry stub tables with just
    //   <table name="..." storageaddress="0x..."/>
    // inheriting everything else from the base template (see resolveBase).
    // The storageaddress attribute IS the ROM offset (the suite converts the
    // hex string directly); readTableValues() returns null without one.
    function getXmlDoc(xmlText) {
        if (typeof DOMParser !== 'undefined') {
            return new DOMParser().parseFromString(xmlText, 'text/xml');
        }
        if (typeof require !== 'undefined') {
            const { DOMParser: XDP } = require('xmldom');
            return new XDP().parseFromString(xmlText, 'text/xml');
        }
        throw new Error('no XML parser available');
    }
    function childEls(el, name) {
        const out = [];
        const want = name.toLowerCase();
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && n.nodeName.toLowerCase() === want) out.push(n);
        }
        return out;
    }
    function textOf(el) {
        return (el.textContent || '').trim();
    }
    function extractSymbol(descEl) {
        for (let n = descEl.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 8) { // comment node: <!--mTTPINT-->
                const m = /([A-Za-z0-9_]+)/.exec(n.nodeValue || '');
                if (m) return m[1];
            }
        }
        return null;
    }
    // RomTable.cs properties may arrive as XML attributes OR child elements
    // (plain C# XmlSerializer maps properties to child elements by name).
    // Try attribute spellings first, then a case-insensitive child element.
    function propVal(el, names) {
        for (const n of names) {
            const v = el.getAttribute(n);
            if (v != null && v !== '') return v;
        }
        for (const n of names) {
            const c = childEls(el, n)[0];
            if (c) { const t = textOf(c); if (t) return t; }
        }
        return null;
    }

    // scalingbase registry: name -> {units, expression, to_byte, format}
    const scalings = new Map();
    function registerScalings(xmlText) {
        const doc = getXmlDoc(xmlText);
        ['scalingbase', 'Scalingbase'].forEach(tagName => {
            const els = doc.getElementsByTagName(tagName);
            for (let i = 0; i < els.length; i++) {
                const e = els[i];
                const name = e.getAttribute('name');
                if (name) scalings.set(name, {
                    name,
                    units: e.getAttribute('units') || '',
                    expression: e.getAttribute('expression') || 'x',
                    toByte: e.getAttribute('to_byte') || 'x',
                    format: e.getAttribute('format') || '0.00',
                });
            }
        });
        return scalings.size;
    }
    // safe math-expression evaluator (whitelisted chars only)
    function makeFn(expr) {
        const clean = String(expr).trim();
        if (!/^[\dx\s\+\-\*\/\.\(\)]+$/i.test(clean)) {
            throw new Error('unsafe scaling expression: ' + expr);
        }
        return new Function('x', `'use strict'; return (${clean});`);
    }
    function scalingFns(s) {
        if (!s._toDisp) {
            s._toDisp = makeFn(s.expression);
            s._toByte = makeFn(s.toByte);
        }
        return s;
    }
    function toDisplay(raw, scaling) {
        const s = resolveScaling(scaling);
        if (!s) return raw;
        return scalingFns(s)._toDisp(raw);
    }
    function toRaw(display, scaling) {
        const s = resolveScaling(scaling);
        if (!s) return Math.round(display);
        return Math.round(scalingFns(s)._toByte(display));
    }
    // <scaling> child element: either suite-style inline attributes
    // (expression/to_byte/...) or a RomRaider-style base="name" reference.
    // Returns an inline scaling object or a registry name (string).
    function parseScalingEl(s) {
        if (!s) return null;
        if (s.getAttribute('expression') || s.getAttribute('to_byte')) {
            return {
                name: null,
                units: s.getAttribute('units') || '',
                expression: s.getAttribute('expression') || 'x',
                toByte: s.getAttribute('to_byte') || 'x',
                format: s.getAttribute('format') || '0.00',
            };
        }
        return s.getAttribute('base') || null;
    }
    function resolveScaling(s) {
        if (!s) return null;
        if (typeof s === 'string') return scalings.get(s) || null;
        return s; // inline object
    }

    function parseAxisEl(a) {
        // RomTableAxis carries its own StorageAddress + Endian (per C# model);
        // may be an attribute or a child element — try several spellings.
        const addrAttr = propVal(a, ['storageaddress', 'storageAddress', 'address']);
        const scalingEl = childEls(a, 'scaling')[0];
        const addr = addrAttr != null ? hex(addrAttr) : null;
        const explicit = new Set();
        const at = a.attributes || [];
        for (let i = 0; i < at.length; i++) explicit.add(at[i].name.toLowerCase());
        return {
            type: a.getAttribute('type') || '',
            name: a.getAttribute('name') || '',
            explicit,
            size: parseInt(a.getAttribute('sizex') || '0', 10),
            storagetype: a.getAttribute('storagetype') || null,
            endian: propVal(a, ['endian']) || null,
            storageAddress: addr,
            scaling: parseScalingEl(scalingEl),
            // suite 2D axes carry static values as <data value="..."/>;
            // RomRaider style uses text content — accept both.
            values: childEls(a, 'data').map(d => {
                const v = d.getAttribute('value');
                return parseFloat(v != null && v !== '' ? v : textOf(d));
            }),
            // dynamic (non-static) axes live in the ROM at storageAddress
            address: addr,
        };
    }
    function parseTableEl(t) {
        const scalingEl = childEls(t, 'scaling')[0];
        const descEl = childEls(t, 'description')[0];
        // RomTable carries StorageAddress too (attr or child element).
        const addrAttr = propVal(t, ['storageaddress', 'storageAddress', 'address']);
        const axes = childEls(t, 'table')
            .filter(a => /axis/i.test(a.getAttribute('type') || ''))
            .map(parseAxisEl);
        const findAxis = (re) => axes.find(ax => re.test(ax.type)) || null;
        // Track which attributes were explicitly present: ROM files carry
        // stub tables (<table name="..." storageaddress="..."/>) that inherit
        // everything else from the base template — merge must not let
        // defaulted values clobber the base's explicit ones.
        const explicit = new Set();
        const at = t.attributes || [];
        for (let i = 0; i < at.length; i++) explicit.add(at[i].name.toLowerCase());
        return {
            kind: 'table',
            explicit,
            type: t.getAttribute('type') || '',           // 2D | 3D
            name: t.getAttribute('name') || '',
            category: (t.getAttribute('category') || '').split('//'),
            storagetype: t.getAttribute('storagetype') || 'uint8',
            sizex: parseInt(t.getAttribute('sizex') || '0', 10),
            sizey: parseInt(t.getAttribute('sizey') || '0', 10),
            userlevel: parseInt(t.getAttribute('userlevel') || '0', 10),
            scaling: parseScalingEl(scalingEl),
            axes,
            xAxis: findAxis(/x\s*axis/i),
            yAxis: findAxis(/y\s*axis/i),
            description: descEl ? textOf(descEl) : '',
            symbol: descEl ? extractSymbol(descEl) : null,
            storageAddress: addrAttr != null ? hex(addrAttr) : null,
            endian: propVal(t, ['endian']) || null,
            // In suite/RomRaider definitions the storageaddress attribute IS
            // the ROM offset (MainForm converts the hex string directly).
            address: addrAttr != null ? hex(addrAttr) : null,
        };
    }
    function parseTables(xmlText) {
        const doc = getXmlDoc(xmlText);
        const tables = [];
        const all = doc.getElementsByTagName('table');
        for (let i = 0; i < all.length; i++) {
            const t = all[i];
            // skip nested axis tables — parsed with their parent
            let p = t.parentNode, nested = false;
            while (p) {
                if (p.nodeType === 1 && p.nodeName.toLowerCase() === 'table') { nested = true; break; }
                p = p.parentNode;
            }
            if (nested) continue;
            tables.push(parseTableEl(t));
        }
        return tables;
    }

    // ---- XDF (TunerPro) parsing ----
    function isXdf(xmlText) {
        return /<XDFFORMAT[\s>]/i.test(xmlText.slice(0, 4000));
    }
    function xdfChild(el, name) {
        const want = name.toLowerCase();
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && n.nodeName.toLowerCase() === want) return n;
        }
        return null;
    }
    function xdfChildren(el, name) {
        const out = [];
        const want = name.toLowerCase();
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && n.nodeName.toLowerCase() === want) out.push(n);
        }
        return out;
    }
    function xdfText(el, name) {
        const c = xdfChild(el, name);
        return c ? (c.textContent || '').trim() : '';
    }
    // XDF numbers: hex ("0x1C234", "1C234") or signed decimal ("-520", "16")
    function xdfNum(v) {
        if (v == null) return NaN;
        v = String(v).trim();
        if (!v) return NaN;
        if (/^0x/i.test(v) || /[a-f]/i.test(v)) return parseInt(v, 16);
        return parseInt(v, 10);
    }
    // <MATH equation="..."> -> scaling object. The display expression is
    // used as-is (X normalized to x); the write-back expression is the
    // numeric inverse, which is exact for linear equations (nearly all
    // GM XDF math) and a linear approximation otherwise.
    function parseXdfMath(axisEl) {
        const mathEl = xdfChild(axisEl, 'MATH');
        let expr = mathEl ? (mathEl.getAttribute('equation') || 'X') : 'X';
        expr = expr.replace(/\bX\b/g, 'x');
        let ok = true, a = 1, b = 0;
        try {
            const fn = makeFn(expr);
            const f0 = fn(0), f1 = fn(1);
            if (!isFinite(f0) || !isFinite(f1)) throw new Error('non-finite');
            b = f0; a = f1 - f0;
        } catch (e) { ok = false; }
        if (!ok) expr = 'x';
        const toByte = (ok && a !== 0 && isFinite(a))
            ? `((x - (${b})) / (${a}))`
            : 'x';
        const decimalpl = Math.max(0, Math.min(6,
            parseInt(xdfText(axisEl, 'decimalpl') || '2', 10) || 0));
        return {
            name: null,
            units: xdfText(axisEl, 'units'),
            expression: expr,
            toByte,
            format: '0.' + '0'.repeat(decimalpl),
        };
    }
    function parseXdfAxis(axisEl, baseoffset) {
        const id = (axisEl.getAttribute('id') || '').toLowerCase(); // x | y | z
        const emb = xdfChild(axisEl, 'EMBEDDEDDATA');
        let address = null, elemBits = 16, rows = 0, cols = 0;
        if (emb) {
            address = xdfNum(emb.getAttribute('mmedaddress'));
            if (!Number.isNaN(address) && !Number.isNaN(baseoffset)) address += baseoffset;
            if (Number.isNaN(address)) address = null;
            elemBits = parseInt(emb.getAttribute('mmedelementsizebits') || '16', 10) || 16;
            rows = parseInt(emb.getAttribute('mmedrowcount') || '0', 10) || 0;
            cols = parseInt(emb.getAttribute('mmedcolcount') || '0', 10) || 0;
        }
        const indexcount = parseInt(xdfText(axisEl, 'indexcount') || '0', 10) || 0;
        // Static axes carry their labels as <LABEL index="n" value="v"/>
        const labels = xdfChildren(axisEl, 'LABEL')
            .map(l => ({
                i: parseInt(l.getAttribute('index') || '0', 10) || 0,
                v: parseFloat(l.getAttribute('value')),
            }))
            .filter(p => isFinite(p.v))
            .sort((p, q) => p.i - q.i)
            .map(p => p.v);
        const storagetype = elemBits <= 8 ? 'uint8' : elemBits <= 16 ? 'uint16' : 'uint32';
        return {
            type: id + ' axis',
            name: '',
            size: indexcount || cols || rows || labels.length || 0,
            storagetype,
            endian: 'Little',
            storageAddress: address,
            address,
            scaling: parseXdfMath(axisEl),
            values: labels, // static; when empty and address set, read from ROM
            rows, cols,
        };
    }
    function parseXdfTable(tableEl, catMap, baseoffset) {
        const title = xdfText(tableEl, 'title');
        const uniqueid = tableEl.getAttribute('uniqueid') || '';
        const axes = xdfChildren(tableEl, 'XDFAXIS').map(a => parseXdfAxis(a, baseoffset));
        const byId = {};
        axes.forEach(a => { byId[a.type.charAt(0)] = a; }); // 'x axis' -> 'x'
        const z = byId['z'] || null;
        const sizex = (z && z.cols) || (byId['x'] && byId['x'].size) || 1;
        const sizey = (z && z.rows) || (byId['y'] && byId['y'].size) || 1;
        const addr = z ? z.address : null;
        const storagetype = (z && z.storagetype) || 'uint16';
        const cats = xdfChildren(tableEl, 'CATEGORYMEM')
            .map(c => catMap.get(c.getAttribute('category')))
            .filter(c => c);
        return {
            kind: 'table',
            type: (sizex > 1 && sizey > 1) ? '3D' : '2D',
            name: title,
            category: cats,
            storagetype,
            sizex, sizey,
            userlevel: 0,
            scaling: z ? z.scaling : null,
            axes: axes.filter(a => a !== z),
            xAxis: byId['x'] || null,
            yAxis: byId['y'] || null,
            description: xdfText(tableEl, 'description'),
            symbol: uniqueid || null,
            storageAddress: addr,
            address: addr, // absolute file offset (mmedaddress + BASEOFFSET)
            endian: 'Little',
            explicit: new Set(['storagetype', 'sizex', 'sizey', 'storageaddress', 'endian']),
        };
    }
    function parseXdf(xmlText, fileName) {
        const doc = getXmlDoc(xmlText);
        const root = doc.documentElement;
        const header = xdfChild(root, 'XDFHEADER') || root;
        let baseoffset = xdfNum(xdfText(header, 'BASEOFFSET'));
        if (Number.isNaN(baseoffset)) baseoffset = 0;
        const catMap = new Map();
        xdfChildren(header, 'CATEGORY').forEach(c => {
            catMap.set(c.getAttribute('index'), c.getAttribute('name') || '');
        });
        const deftitle = xdfText(header, 'deftitle');
        const tables = xdfChildren(root, 'XDFTABLE')
            .map(t => parseXdfTable(t, catMap, baseoffset));
        const shortName = (fileName || '').replace(/\.[^.]+$/, '');
        let id = deftitle || shortName || 'xdf';
        if (registry.has(id)) id = shortName || (id + ' (2)');
        return {
            kind: 'xdf',
            id,
            base: null,
            romid: {
                xmlid: id,
                internalidaddress: NaN,
                internalidstring: '',
                filesizeBytes: NaN,
                endian: 'Little',
                make: 'GM',
                description: xdfText(header, 'description'),
            },
            checksums: [],
            tables,
            categories: [...catMap.values()].filter(c => c),
            raw: xmlText,
        };
    }

    // raw value extraction / write-back (needs a ROM address;
    // uses table.address, falling back to table.storageAddress)
    function storageSize(storagetype) {
        const s = String(storagetype || '').toLowerCase();
        if (s === 'uint32' || s === 'int32') return 4;
        if (s === 'uint16' || s === 'int16') return 2;
        return 1;
    }
    function readElem(b, a, sz, be) {
        if (sz === 1) return b[a];
        if (sz === 2) return be ? (b[a] << 8) | b[a + 1] : b[a] | (b[a + 1] << 8);
        const w = be ? ((b[a] << 24) | (b[a + 1] << 16) | (b[a + 2] << 8) | b[a + 3])
                     : (b[a] | (b[a + 1] << 8) | (b[a + 2] << 16) | (b[a + 3] << 24));
        return w >>> 0;
    }
    function writeElem(b, a, sz, be, v) {
        v = v >>> 0;
        if (sz === 1) { b[a] = v & 0xFF; return; }
        if (sz === 2) {
            if (be) { b[a] = (v >> 8) & 0xFF; b[a + 1] = v & 0xFF; }
            else { b[a] = v & 0xFF; b[a + 1] = (v >> 8) & 0xFF; }
            return;
        }
        if (be) {
            b[a] = (v >>> 24) & 0xFF; b[a + 1] = (v >>> 16) & 0xFF;
            b[a + 2] = (v >>> 8) & 0xFF; b[a + 3] = v & 0xFF;
        } else {
            b[a] = v & 0xFF; b[a + 1] = (v >>> 8) & 0xFF;
            b[a + 2] = (v >>> 16) & 0xFF; b[a + 3] = (v >>> 24) & 0xFF;
        }
    }
    function tableAddress(table) {
        return table.address != null ? table.address : table.storageAddress;
    }
    function readTableValues(romBytes, table, endian) {
        const addr = tableAddress(table);
        if (addr == null) return null; // no address yet
        const b = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
        const be = (table.endian || endian || 'Big').toLowerCase().startsWith('big');
        const sz = storageSize(table.storagetype);
        const nx = table.sizex || 1, ny = table.sizey || 1;
        const get = (i) => readElem(b, addr + i * sz, sz, be);
        if (ny <= 1) {
            const vals = [];
            for (let i = 0; i < nx; i++) vals.push(get(i));
            return vals;
        }
        const grid = [];
        for (let y = 0; y < ny; y++) {
            const row = [];
            for (let x = 0; x < nx; x++) row.push(get(y * nx + x));
            grid.push(row);
        }
        return grid;
    }
    function readTableScaled(romBytes, table, endian) {
        const raw = readTableValues(romBytes, table, endian);
        if (!raw) return null;
        const sc = (v) => toDisplay(v, table.scaling);
        return Array.isArray(raw[0]) ? raw.map(row => row.map(sc)) : raw.map(sc);
    }
    function writeTableValues(romBytes, table, rawVals, endian) {
        const addr = tableAddress(table);
        if (addr == null) return false;
        const b = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
        const be = (table.endian || endian || 'Big').toLowerCase().startsWith('big');
        const sz = storageSize(table.storagetype);
        const flat = Array.isArray(rawVals[0]) ? rawVals.flat() : rawVals;
        flat.forEach((v, i) => {
            const a = addr + i * sz;
            if (a + sz > b.length) return;
            writeElem(b, a, sz, be, v);
        });
        return true;
    }
    // Dynamic axis values live in the ROM at the axis's storageAddress.
    // count defaults to the axis's own size; pass the table's sizex/sizey
    // when the axis declares none (RomRaider style).
    function readAxisValues(romBytes, axis, endian, count) {
        if (!axis || axis.storageAddress == null) {
            // static axis: values are baked into the definition
            return (axis && axis.values) || [];
        }
        const b = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes);
        const be = (axis.endian || endian || 'Big').toLowerCase().startsWith('big');
        const sz = storageSize(axis.storagetype || 'uint8');
        const n = count || axis.size || 0;
        const vals = [];
        for (let i = 0; i < n; i++) vals.push(readElem(b, axis.storageAddress + i * sz, sz, be));
        return vals;
    }
    function readAxisScaled(romBytes, axis, endian, count) {
        const raw = readAxisValues(romBytes, axis, endian, count);
        return raw.map(v => toDisplay(v, axis.scaling));
    }

    // ---- checksums ----
    // Ported from the suite's MainForm.FixChecksums (ababook/NisROM-Tuning-Suite):
    // 32-bit wrapping sum + XOR over 4-byte big-endian words of the whole ROM,
    // skipping the checksum slots themselves. HR-style ROMs (1MB/1.5MB with
    // 0xFFFF7FFC markers at 0x20008/0x20010) start at 0x8204 and skip 0x20000.
    // Slot addresses come from <checksum sumloc="..." xorloc="..."/> elements.
    // Both values are written back big-endian as uint32.
    function fixChecksums(bytes, def) {
        const b = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        const getU32 = (a) => (((b[a] << 24) | (b[a + 1] << 16) | (b[a + 2] << 8) | b[a + 3]) >>> 0);
        const setU32 = (a, v) => {
            b[a] = (v >>> 24) & 0xFF; b[a + 1] = (v >>> 16) & 0xFF;
            b[a + 2] = (v >>> 8) & 0xFF; b[a + 3] = v & 0xFF;
        };
        // Port of MainForm.FixChecksums: the suite iterates every <checksum>
        // element and OVERWRITES its checksumXOR/checksumSum each time, so
        // only the LAST element in the file takes effect. (start/end/type
        // attributes are ignored — the whole ROM is always checksummed.)
        const cs = (def.checksums || []).filter(c =>
            Number.isInteger(c.sumloc) && Number.isInteger(c.xorloc) &&
            c.sumloc + 4 <= b.length && c.xorloc + 4 <= b.length
        ).pop();
        const applied = [];
        if (cs) {
            const sumAddress = cs.sumloc, xorAddress = cs.xorloc;
            let hrStyle = false;
            if (b.length > 0x20014 && (b.length === 0x100000 || b.length === 0x180000)) {
                const c1 = getU32(0x20008), c2 = getU32(0x20010);
                if (c1 === 0xFFFF7FFC && c2 === c1) hrStyle = true;
            }
            const startOffset = hrStyle ? 0x8204 : 0;
            let sum = 0, xor = 0;
            for (let count = startOffset; count + 4 <= b.length; count += 4) {
                if (count === xorAddress || count === sumAddress) continue;
                if (hrStyle && count === 0x20000) continue;
                const v = getU32(count);
                sum = (sum + v) >>> 0;
                xor = (xor ^ v) >>> 0;
            }
            setU32(sumAddress, sum);
            setU32(xorAddress, xor);
            applied.push({
                sumloc: '0x' + sumAddress.toString(16).toUpperCase(),
                xorloc: '0x' + xorAddress.toString(16).toUpperCase(),
                sum: '0x' + sum.toString(16).toUpperCase(),
                xor: '0x' + xor.toString(16).toUpperCase(),
                hrStyle,
            });
        }
        return { bytes: b, applied };
    }

    return {
        register, parseDefinition, parseTables, registerScalings,
        matchRom, resolveBase,
        fixChecksums,
        toDisplay, toRaw, readTableValues, readTableScaled, writeTableValues,
        readAxisValues, readAxisScaled,
        get: (xmlid) => registry.get(xmlid),
        list: () => [...registry.keys()],
        scalingList: () => [...scalings.keys()],
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Defs;
