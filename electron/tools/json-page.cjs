'use strict';
/** Runs both in Node tests and in the page; never assumes a JSON response is an array. */
function projectJson(data, options) {
  const own = (object, field) => field.split('.').reduce((v, key) =>
    v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined, object);
  const collection = options.items_path ? own(data, options.items_path) : data;
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  const fields = Array.isArray(options.fields) ? options.fields.filter((f) => typeof f === 'string').slice(0, 30) : [];
  const small = (value) => typeof value === 'string' ? value.slice(0, 2000) : value;
  if (!Array.isArray(collection)) {
    return { kind: typeof collection, isArray: false, keys: collection && typeof collection === 'object' ? Object.keys(collection).slice(0, 40) : [],
      sample: JSON.stringify(collection)?.slice(0, 4000),
      note: '返回值不是数组。先检查 HTTP 状态和这些字段；若数组在子字段中，请提供 items_path。不要对这个对象直接调用 map。' };
  }
  const keys = collection[0] && typeof collection[0] === 'object' ? Object.keys(collection[0]).slice(0, 40) : [];
  const selected = fields.length ? fields : keys.filter((k) => collection[0][k] === null || typeof collection[0][k] !== 'object').slice(0, 16);
  return { isArray: true, keys, totalInPage: collection.length, offset,
    nextOffset: offset + limit < collection.length ? offset + limit : null,
    items: collection.slice(offset, offset + limit).map((row) =>
      row && typeof row === 'object' ? Object.fromEntries(selected.map((f) => [f, small(own(row, f))])) : small(row)),
  };
}
module.exports = { projectJson };
