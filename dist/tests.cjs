'use strict';

var t = require('lib0/testing');
var prng = require('lib0/prng');
var encoding$1 = require('lib0/encoding');
var decoding = require('lib0/decoding');
var binary = require('lib0/binary');
var map$1 = require('lib0/map');
var math = require('lib0/math');
var array$1 = require('lib0/array');
var buffer = require('lib0/buffer');
var error = require('lib0/error');
var f = require('lib0/function');
var logging = require('lib0/logging');
var string = require('lib0/string');
var observable = require('lib0/observable');
var random = require('lib0/random');
var promise = require('lib0/promise');
var set = require('lib0/set');
var object = require('lib0/object');
var iterator = require('lib0/iterator');
var time = require('lib0/time');
var environment = require('lib0/environment');

function _interopNamespaceDefault(e) {
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var t__namespace = /*#__PURE__*/_interopNamespaceDefault(t);
var prng__namespace = /*#__PURE__*/_interopNamespaceDefault(prng);
var encoding__namespace = /*#__PURE__*/_interopNamespaceDefault(encoding$1);
var decoding__namespace = /*#__PURE__*/_interopNamespaceDefault(decoding);
var binary__namespace = /*#__PURE__*/_interopNamespaceDefault(binary);
var map__namespace = /*#__PURE__*/_interopNamespaceDefault(map$1);
var math__namespace = /*#__PURE__*/_interopNamespaceDefault(math);
var array__namespace = /*#__PURE__*/_interopNamespaceDefault(array$1);
var buffer__namespace = /*#__PURE__*/_interopNamespaceDefault(buffer);
var error__namespace = /*#__PURE__*/_interopNamespaceDefault(error);
var f__namespace = /*#__PURE__*/_interopNamespaceDefault(f);
var logging__namespace = /*#__PURE__*/_interopNamespaceDefault(logging);
var string__namespace = /*#__PURE__*/_interopNamespaceDefault(string);
var random__namespace = /*#__PURE__*/_interopNamespaceDefault(random);
var promise__namespace = /*#__PURE__*/_interopNamespaceDefault(promise);
var set__namespace = /*#__PURE__*/_interopNamespaceDefault(set);
var object__namespace = /*#__PURE__*/_interopNamespaceDefault(object);
var iterator__namespace = /*#__PURE__*/_interopNamespaceDefault(iterator);
var time__namespace = /*#__PURE__*/_interopNamespaceDefault(time);

/**
 * This is an abstract interface that all Connectors should implement to keep them interchangeable.
 *
 * @note This interface is experimental and it is not advised to actually inherit this class.
 *       It just serves as typing information.
 *
 * @extends {ObservableV2<any>}
 */
class AbstractConnector extends observable.ObservableV2 {
  /**
   * @param {Doc} ydoc
   * @param {any} awareness
   */
  constructor (ydoc, awareness) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
  }
}

class DeleteItem {
  /**
   * @param {number} clock
   * @param {number} len
   */
  constructor (clock, len) {
    /**
     * @type {number}
     */
    this.clock = clock;
    /**
     * @type {number}
     */
    this.len = len;
  }
}

/**
 * We no longer maintain a DeleteStore. DeleteSet is a temporary object that is created when needed.
 * - When created in a transaction, it must only be accessed after sorting, and merging
 *   - This DeleteSet is send to other clients
 * - We do not create a DeleteSet when we send a sync message. The DeleteSet message is created directly from StructStore
 * - We read a DeleteSet as part of a sync/update message. In this case the DeleteSet is already sorted and merged.
 */
class DeleteSet {
  constructor () {
    /**
     * @type {Map<number,Array<DeleteItem>>}
     */
    this.clients = new Map();
  }
}

/**
 * Iterate over all structs that the DeleteSet gc's.
 *
 * @param {Transaction} transaction
 * @param {DeleteSet} ds
 * @param {function(GC|Item):void} f
 *
 * @function
 */
const iterateDeletedStructs = (transaction, ds, f) =>
  ds.clients.forEach((deletes, clientid) => {
    const structs = /** @type {Array<GC|Item>} */ (transaction.doc.store.clients.get(clientid));
    for (let i = 0; i < deletes.length; i++) {
      const del = deletes[i];
      iterateStructs(transaction, structs, del.clock, del.len, f);
    }
  });

/**
 * @param {Array<DeleteItem>} dis
 * @param {number} clock
 * @return {number|null}
 *
 * @private
 * @function
 */
const findIndexDS = (dis, clock) => {
  let left = 0;
  let right = dis.length - 1;
  while (left <= right) {
    const midindex = math__namespace.floor((left + right) / 2);
    const mid = dis[midindex];
    const midclock = mid.clock;
    if (midclock <= clock) {
      if (clock < midclock + mid.len) {
        return midindex
      }
      left = midindex + 1;
    } else {
      right = midindex - 1;
    }
  }
  return null
};

/**
 * @param {DeleteSet} ds
 * @param {ID} id
 * @return {boolean}
 *
 * @private
 * @function
 */
const isDeleted = (ds, id) => {
  const dis = ds.clients.get(id.client);
  return dis !== undefined && findIndexDS(dis, id.clock) !== null
};

/**
 * @param {DeleteSet} ds
 *
 * @private
 * @function
 */
const sortAndMergeDeleteSet = ds => {
  ds.clients.forEach(dels => {
    dels.sort((a, b) => a.clock - b.clock);
    // merge items without filtering or splicing the array
    // i is the current pointer
    // j refers to the current insert position for the pointed item
    // try to merge dels[i] into dels[j-1] or set dels[j]=dels[i]
    let i, j;
    for (i = 1, j = 1; i < dels.length; i++) {
      const left = dels[j - 1];
      const right = dels[i];
      if (left.clock + left.len >= right.clock) {
        left.len = math__namespace.max(left.len, right.clock + right.len - left.clock);
      } else {
        if (j < i) {
          dels[j] = right;
        }
        j++;
      }
    }
    dels.length = j;
  });
};

/**
 * @param {Array<DeleteSet>} dss
 * @return {DeleteSet} A fresh DeleteSet
 */
const mergeDeleteSets = dss => {
  const merged = new DeleteSet();
  for (let dssI = 0; dssI < dss.length; dssI++) {
    dss[dssI].clients.forEach((delsLeft, client) => {
      if (!merged.clients.has(client)) {
        // Write all missing keys from current ds and all following.
        // If merged already contains `client` current ds has already been added.
        /**
         * @type {Array<DeleteItem>}
         */
        const dels = delsLeft.slice();
        for (let i = dssI + 1; i < dss.length; i++) {
          array__namespace.appendTo(dels, dss[i].clients.get(client) || []);
        }
        merged.clients.set(client, dels);
      }
    });
  }
  sortAndMergeDeleteSet(merged);
  return merged
};

/**
 * @param {DeleteSet} ds
 * @param {number} client
 * @param {number} clock
 * @param {number} length
 *
 * @private
 * @function
 */
const addToDeleteSet = (ds, client, clock, length) => {
  map__namespace.setIfUndefined(ds.clients, client, () => /** @type {Array<DeleteItem>} */ ([])).push(new DeleteItem(clock, length));
};

const createDeleteSet = () => new DeleteSet();

/**
 * @param {StructStore} ss
 * @return {DeleteSet} Merged and sorted DeleteSet
 *
 * @private
 * @function
 */
const createDeleteSetFromStructStore = ss => {
  const ds = createDeleteSet();
  ss.clients.forEach((structs, client) => {
    /**
     * @type {Array<DeleteItem>}
     */
    const dsitems = [];
    for (let i = 0; i < structs.length; i++) {
      const struct = structs[i];
      if (struct.deleted) {
        const clock = struct.id.clock;
        let len = struct.length;
        if (i + 1 < structs.length) {
          for (let next = structs[i + 1]; i + 1 < structs.length && next.deleted; next = structs[++i + 1]) {
            len += next.length;
          }
        }
        dsitems.push(new DeleteItem(clock, len));
      }
    }
    if (dsitems.length > 0) {
      ds.clients.set(client, dsitems);
    }
  });
  return ds
};

/**
 * @param {DSEncoderV1 | DSEncoderV2} encoder
 * @param {DeleteSet} ds
 *
 * @private
 * @function
 */
const writeDeleteSet = (encoder, ds) => {
  encoding__namespace.writeVarUint(encoder.restEncoder, ds.clients.size);

  // Ensure that the delete set is written in a deterministic order
  array__namespace.from(ds.clients.entries())
    .sort((a, b) => b[0] - a[0])
    .forEach(([client, dsitems]) => {
      encoder.resetDsCurVal();
      encoding__namespace.writeVarUint(encoder.restEncoder, client);
      const len = dsitems.length;
      encoding__namespace.writeVarUint(encoder.restEncoder, len);
      for (let i = 0; i < len; i++) {
        const item = dsitems[i];
        encoder.writeDsClock(item.clock);
        encoder.writeDsLen(item.len);
      }
    });
};

/**
 * @param {DSDecoderV1 | DSDecoderV2} decoder
 * @return {DeleteSet}
 *
 * @private
 * @function
 */
const readDeleteSet = decoder => {
  const ds = new DeleteSet();
  const numClients = decoding__namespace.readVarUint(decoder.restDecoder);
  for (let i = 0; i < numClients; i++) {
    decoder.resetDsCurVal();
    const client = decoding__namespace.readVarUint(decoder.restDecoder);
    const numberOfDeletes = decoding__namespace.readVarUint(decoder.restDecoder);
    if (numberOfDeletes > 0) {
      const dsField = map__namespace.setIfUndefined(ds.clients, client, () => /** @type {Array<DeleteItem>} */ ([]));
      for (let i = 0; i < numberOfDeletes; i++) {
        dsField.push(new DeleteItem(decoder.readDsClock(), decoder.readDsLen()));
      }
    }
  }
  return ds
};

/**
 * @todo YDecoder also contains references to String and other Decoders. Would make sense to exchange YDecoder.toUint8Array for YDecoder.DsToUint8Array()..
 */

/**
 * @param {DSDecoderV1 | DSDecoderV2} decoder
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @return {Uint8Array|null} Returns a v2 update containing all deletes that couldn't be applied yet; or null if all deletes were applied successfully.
 *
 * @private
 * @function
 */
const readAndApplyDeleteSet = (decoder, transaction, store) => {
  const unappliedDS = new DeleteSet();
  const numClients = decoding__namespace.readVarUint(decoder.restDecoder);
  for (let i = 0; i < numClients; i++) {
    decoder.resetDsCurVal();
    const client = decoding__namespace.readVarUint(decoder.restDecoder);
    const numberOfDeletes = decoding__namespace.readVarUint(decoder.restDecoder);
    const structs = store.clients.get(client) || [];
    const state = getState(store, client);
    for (let i = 0; i < numberOfDeletes; i++) {
      const clock = decoder.readDsClock();
      const clockEnd = clock + decoder.readDsLen();
      if (clock < state) {
        if (state < clockEnd) {
          addToDeleteSet(unappliedDS, client, state, clockEnd - state);
        }
        let index = findIndexSS(structs, clock);
        /**
         * We can ignore the case of GC and Delete structs, because we are going to skip them
         * @type {Item}
         */
        // @ts-ignore
        let struct = structs[index];
        // split the first item if necessary
        if (!struct.deleted && struct.id.clock < clock) {
          structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
          index++; // increase we now want to use the next struct
        }
        while (index < structs.length) {
          // @ts-ignore
          struct = structs[index++];
          if (struct.id.clock < clockEnd) {
            if (!struct.deleted) {
              if (clockEnd < struct.id.clock + struct.length) {
                structs.splice(index, 0, splitItem(transaction, struct, clockEnd - struct.id.clock));
              }
              struct.delete(transaction);
            }
          } else {
            break
          }
        }
      } else {
        addToDeleteSet(unappliedDS, client, clock, clockEnd - clock);
      }
    }
  }
  if (unappliedDS.clients.size > 0) {
    const ds = new UpdateEncoderV2();
    encoding__namespace.writeVarUint(ds.restEncoder, 0); // encode 0 structs
    writeDeleteSet(ds, unappliedDS);
    return ds.toUint8Array()
  }
  return null
};

/**
 * @param {DeleteSet} ds1
 * @param {DeleteSet} ds2
 */
const equalDeleteSets = (ds1, ds2) => {
  if (ds1.clients.size !== ds2.clients.size) return false
  for (const [client, deleteItems1] of ds1.clients.entries()) {
    const deleteItems2 = /** @type {Array<import('../internals.js').DeleteItem>} */ (ds2.clients.get(client));
    if (deleteItems2 === undefined || deleteItems1.length !== deleteItems2.length) return false
    for (let i = 0; i < deleteItems1.length; i++) {
      const di1 = deleteItems1[i];
      const di2 = deleteItems2[i];
      if (di1.clock !== di2.clock || di1.len !== di2.len) {
        return false
      }
    }
  }
  return true
};

/**
 * @module Y
 */


const generateNewClientId = random__namespace.uint32;

/**
 * @typedef {Object} DocOpts
 * @property {boolean} [DocOpts.gc=true] Disable garbage collection (default: gc=true)
 * @property {function(Item):boolean} [DocOpts.gcFilter] Will be called before an Item is garbage collected. Return false to keep the Item.
 * @property {string} [DocOpts.guid] Define a globally unique identifier for this document
 * @property {string | null} [DocOpts.collectionid] Associate this document with a collection. This only plays a role if your provider has a concept of collection.
 * @property {any} [DocOpts.meta] Any kind of meta information you want to associate with this document. If this is a subdocument, remote peers will store the meta information as well.
 * @property {boolean} [DocOpts.autoLoad] If a subdocument, automatically load document. If this is a subdocument, remote peers will load the document as well automatically.
 * @property {boolean} [DocOpts.shouldLoad] Whether the document should be synced by the provider now. This is toggled to true when you call ydoc.load()
 */

/**
 * @typedef {Object} DocEvents
 * @property {function(Doc):void} DocEvents.destroy
 * @property {function(Doc):void} DocEvents.load
 * @property {function(boolean, Doc):void} DocEvents.sync
 * @property {function(Uint8Array, any, Doc, Transaction):void} DocEvents.update
 * @property {function(Uint8Array, any, Doc, Transaction):void} DocEvents.updateV2
 * @property {function(Doc):void} DocEvents.beforeAllTransactions
 * @property {function(Transaction, Doc):void} DocEvents.beforeTransaction
 * @property {function(Transaction, Doc):void} DocEvents.beforeObserverCalls
 * @property {function(Transaction, Doc):void} DocEvents.afterTransaction
 * @property {function(Transaction, Doc):void} DocEvents.afterTransactionCleanup
 * @property {function(Doc, Array<Transaction>):void} DocEvents.afterAllTransactions
 * @property {function({ loaded: Set<Doc>, added: Set<Doc>, removed: Set<Doc> }, Doc, Transaction):void} DocEvents.subdocs
 */

/**
 * A Yjs instance handles the state of shared data.
 * @extends ObservableV2<DocEvents>
 */
class Doc extends observable.ObservableV2 {
  /**
   * @param {DocOpts} opts configuration
   */
  constructor ({ guid = random__namespace.uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true } = {}) {
    super();
    this.gc = gc;
    this.gcFilter = gcFilter;
    this.clientID = generateNewClientId();
    this.guid = guid;
    this.collectionid = collectionid;
    /**
     * @type {Map<string, AbstractType<YEvent<any>>>}
     */
    this.share = new Map();
    this.store = new StructStore();
    /**
     * @type {Transaction | null}
     */
    this._transaction = null;
    /**
     * @type {Array<Transaction>}
     */
    this._transactionCleanups = [];
    /**
     * @type {Set<Doc>}
     */
    this.subdocs = new Set();
    /**
     * If this document is a subdocument - a document integrated into another document - then _item is defined.
     * @type {Item?}
     */
    this._item = null;
    this.shouldLoad = shouldLoad;
    this.autoLoad = autoLoad;
    this.meta = meta;
    /**
     * This is set to true when the persistence provider loaded the document from the database or when the `sync` event fires.
     * Note that not all providers implement this feature. Provider authors are encouraged to fire the `load` event when the doc content is loaded from the database.
     *
     * @type {boolean}
     */
    this.isLoaded = false;
    /**
     * This is set to true when the connection provider has successfully synced with a backend.
     * Note that when using peer-to-peer providers this event may not provide very useful.
     * Also note that not all providers implement this feature. Provider authors are encouraged to fire
     * the `sync` event when the doc has been synced (with `true` as a parameter) or if connection is
     * lost (with false as a parameter).
     */
    this.isSynced = false;
    /**
     * Promise that resolves once the document has been loaded from a presistence provider.
     */
    this.whenLoaded = promise__namespace.create(resolve => {
      this.on('load', () => {
        this.isLoaded = true;
        resolve(this);
      });
    });
    const provideSyncedPromise = () => promise__namespace.create(resolve => {
      /**
       * @param {boolean} isSynced
       */
      const eventHandler = (isSynced) => {
        if (isSynced === undefined || isSynced === true) {
          this.off('sync', eventHandler);
          resolve();
        }
      };
      this.on('sync', eventHandler);
    });
    this.on('sync', isSynced => {
      if (isSynced === false && this.isSynced) {
        this.whenSynced = provideSyncedPromise();
      }
      this.isSynced = isSynced === undefined || isSynced === true;
      if (this.isSynced && !this.isLoaded) {
        this.emit('load', [this]);
      }
    });
    /**
     * Promise that resolves once the document has been synced with a backend.
     * This promise is recreated when the connection is lost.
     * Note the documentation about the `isSynced` property.
     */
    this.whenSynced = provideSyncedPromise();
  }

  /**
   * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
   *
   * `load()` might be used in the future to request any provider to load the most current data.
   *
   * It is safe to call `load()` multiple times.
   */
  load () {
    const item = this._item;
    if (item !== null && !this.shouldLoad) {
      transact(/** @type {any} */ (item.parent).doc, transaction => {
        transaction.subdocsLoaded.add(this);
      }, null, true);
    }
    this.shouldLoad = true;
  }

  getSubdocs () {
    return this.subdocs
  }

  getSubdocGuids () {
    return new Set(array__namespace.from(this.subdocs).map(doc => doc.guid))
  }

  /**
   * Changes that happen inside of a transaction are bundled. This means that
   * the observer fires _after_ the transaction is finished and that all changes
   * that happened inside of the transaction are sent as one message to the
   * other peers.
   *
   * @template T
   * @param {function(Transaction):T} f The function that should be executed as a transaction
   * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
   * @return T
   *
   * @public
   */
  transact (f, origin = null) {
    return transact(this, f, origin)
  }

  /**
   * Define a shared data type.
   *
   * Multiple calls of `ydoc.get(name, TypeConstructor)` yield the same result
   * and do not overwrite each other. I.e.
   * `ydoc.get(name, Y.Array) === ydoc.get(name, Y.Array)`
   *
   * After this method is called, the type is also available on `ydoc.share.get(name)`.
   *
   * *Best Practices:*
   * Define all types right after the Y.Doc instance is created and store them in a separate object.
   * Also use the typed methods `getText(name)`, `getArray(name)`, ..
   *
   * @template {typeof AbstractType<any>} Type
   * @example
   *   const ydoc = new Y.Doc(..)
   *   const appState = {
   *     document: ydoc.getText('document')
   *     comments: ydoc.getArray('comments')
   *   }
   *
   * @param {string} name
   * @param {Type} TypeConstructor The constructor of the type definition. E.g. Y.Text, Y.Array, Y.Map, ...
   * @return {InstanceType<Type>} The created type. Constructed with TypeConstructor
   *
   * @public
   */
  get (name, TypeConstructor = /** @type {any} */ (AbstractType)) {
    const type = map__namespace.setIfUndefined(this.share, name, () => {
      // @ts-ignore
      const t = new TypeConstructor();
      t._integrate(this, null);
      return t
    });
    const Constr = type.constructor;
    if (TypeConstructor !== AbstractType && Constr !== TypeConstructor) {
      if (Constr === AbstractType) {
        // @ts-ignore
        const t = new TypeConstructor();
        t._map = type._map;
        type._map.forEach(/** @param {Item?} n */ n => {
          for (; n !== null; n = n.left) {
            // @ts-ignore
            n.parent = t;
          }
        });
        t._start = type._start;
        for (let n = t._start; n !== null; n = n.right) {
          n.parent = t;
        }
        t._length = type._length;
        this.share.set(name, t);
        t._integrate(this, null);
        return /** @type {InstanceType<Type>} */ (t)
      } else {
        throw new Error(`Type with the name ${name} has already been defined with a different constructor`)
      }
    }
    return /** @type {InstanceType<Type>} */ (type)
  }

  /**
   * @template T
   * @param {string} [name]
   * @return {YArray<T>}
   *
   * @public
   */
  getArray (name = '') {
    return /** @type {YArray<T>} */ (this.get(name, YArray))
  }

  /**
   * @param {string} [name]
   * @return {YText}
   *
   * @public
   */
  getText (name = '') {
    return this.get(name, YText)
  }

  /**
   * @template T
   * @param {string} [name]
   * @return {YMap<T>}
   *
   * @public
   */
  getMap (name = '') {
    return /** @type {YMap<T>} */ (this.get(name, YMap))
  }

  /**
   * @param {string} [name]
   * @return {YXmlElement}
   *
   * @public
   */
  getXmlElement (name = '') {
    return /** @type {YXmlElement<{[key:string]:string}>} */ (this.get(name, YXmlElement))
  }

  /**
   * @param {string} [name]
   * @return {YXmlFragment}
   *
   * @public
   */
  getXmlFragment (name = '') {
    return this.get(name, YXmlFragment)
  }

  /**
   * Converts the entire document into a js object, recursively traversing each yjs type
   * Doesn't log types that have not been defined (using ydoc.getType(..)).
   *
   * @deprecated Do not use this method and rather call toJSON directly on the shared types.
   *
   * @return {Object<string, any>}
   */
  toJSON () {
    /**
     * @type {Object<string, any>}
     */
    const doc = {};

    this.share.forEach((value, key) => {
      doc[key] = value.toJSON();
    });

    return doc
  }

  /**
   * Emit `destroy` event and unregister all event handlers.
   */
  destroy () {
    array__namespace.from(this.subdocs).forEach(subdoc => subdoc.destroy());
    const item = this._item;
    if (item !== null) {
      this._item = null;
      const content = /** @type {ContentDoc} */ (item.content);
      content.doc = new Doc({ guid: this.guid, ...content.opts, shouldLoad: false });
      content.doc._item = item;
      transact(/** @type {any} */ (item).parent.doc, transaction => {
        const doc = content.doc;
        if (!item.deleted) {
          transaction.subdocsAdded.add(doc);
        }
        transaction.subdocsRemoved.add(this);
      }, null, true);
    }
    // @ts-ignore
    this.emit('destroyed', [true]); // DEPRECATED!
    this.emit('destroy', [this]);
    super.destroy();
  }
}

class DSDecoderV1 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    this.restDecoder = decoder;
  }

  resetDsCurVal () {
    // nop
  }

  /**
   * @return {number}
   */
  readDsClock () {
    return decoding__namespace.readVarUint(this.restDecoder)
  }

  /**
   * @return {number}
   */
  readDsLen () {
    return decoding__namespace.readVarUint(this.restDecoder)
  }
}

class UpdateDecoderV1 extends DSDecoderV1 {
  /**
   * @return {ID}
   */
  readLeftID () {
    return createID(decoding__namespace.readVarUint(this.restDecoder), decoding__namespace.readVarUint(this.restDecoder))
  }

  /**
   * @return {ID}
   */
  readRightID () {
    return createID(decoding__namespace.readVarUint(this.restDecoder), decoding__namespace.readVarUint(this.restDecoder))
  }

  /**
   * Read the next client id.
   * Use this in favor of readID whenever possible to reduce the number of objects created.
   */
  readClient () {
    return decoding__namespace.readVarUint(this.restDecoder)
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readInfo () {
    return decoding__namespace.readUint8(this.restDecoder)
  }

  /**
   * @return {string}
   */
  readString () {
    return decoding__namespace.readVarString(this.restDecoder)
  }

  /**
   * @return {boolean} isKey
   */
  readParentInfo () {
    return decoding__namespace.readVarUint(this.restDecoder) === 1
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readTypeRef () {
    return decoding__namespace.readVarUint(this.restDecoder)
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @return {number} len
   */
  readLen () {
    return decoding__namespace.readVarUint(this.restDecoder)
  }

  /**
   * @return {any}
   */
  readAny () {
    return decoding__namespace.readAny(this.restDecoder)
  }

  /**
   * @return {Uint8Array}
   */
  readBuf () {
    return buffer__namespace.copyUint8Array(decoding__namespace.readVarUint8Array(this.restDecoder))
  }

  /**
   * Legacy implementation uses JSON parse. We use any-decoding in v2.
   *
   * @return {any}
   */
  readJSON () {
    return JSON.parse(decoding__namespace.readVarString(this.restDecoder))
  }

  /**
   * @return {string}
   */
  readKey () {
    return decoding__namespace.readVarString(this.restDecoder)
  }
}

class DSDecoderV2 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    /**
     * @private
     */
    this.dsCurrVal = 0;
    this.restDecoder = decoder;
  }

  resetDsCurVal () {
    this.dsCurrVal = 0;
  }

  /**
   * @return {number}
   */
  readDsClock () {
    this.dsCurrVal += decoding__namespace.readVarUint(this.restDecoder);
    return this.dsCurrVal
  }

  /**
   * @return {number}
   */
  readDsLen () {
    const diff = decoding__namespace.readVarUint(this.restDecoder) + 1;
    this.dsCurrVal += diff;
    return diff
  }
}

class UpdateDecoderV2 extends DSDecoderV2 {
  /**
   * @param {decoding.Decoder} decoder
   */
  constructor (decoder) {
    super(decoder);
    /**
     * List of cached keys. If the keys[id] does not exist, we read a new key
     * from stringEncoder and push it to keys.
     *
     * @type {Array<string>}
     */
    this.keys = [];
    decoding__namespace.readVarUint(decoder); // read feature flag - currently unused
    this.keyClockDecoder = new decoding__namespace.IntDiffOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.clientDecoder = new decoding__namespace.UintOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.leftClockDecoder = new decoding__namespace.IntDiffOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.rightClockDecoder = new decoding__namespace.IntDiffOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.infoDecoder = new decoding__namespace.RleDecoder(decoding__namespace.readVarUint8Array(decoder), decoding__namespace.readUint8);
    this.stringDecoder = new decoding__namespace.StringDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.parentInfoDecoder = new decoding__namespace.RleDecoder(decoding__namespace.readVarUint8Array(decoder), decoding__namespace.readUint8);
    this.typeRefDecoder = new decoding__namespace.UintOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
    this.lenDecoder = new decoding__namespace.UintOptRleDecoder(decoding__namespace.readVarUint8Array(decoder));
  }

  /**
   * @return {ID}
   */
  readLeftID () {
    return new ID(this.clientDecoder.read(), this.leftClockDecoder.read())
  }

  /**
   * @return {ID}
   */
  readRightID () {
    return new ID(this.clientDecoder.read(), this.rightClockDecoder.read())
  }

  /**
   * Read the next client id.
   * Use this in favor of readID whenever possible to reduce the number of objects created.
   */
  readClient () {
    return this.clientDecoder.read()
  }

  /**
   * @return {number} info An unsigned 8-bit integer
   */
  readInfo () {
    return /** @type {number} */ (this.infoDecoder.read())
  }

  /**
   * @return {string}
   */
  readString () {
    return this.stringDecoder.read()
  }

  /**
   * @return {boolean}
   */
  readParentInfo () {
    return this.parentInfoDecoder.read() === 1
  }

  /**
   * @return {number} An unsigned 8-bit integer
   */
  readTypeRef () {
    return this.typeRefDecoder.read()
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @return {number}
   */
  readLen () {
    return this.lenDecoder.read()
  }

  /**
   * @return {any}
   */
  readAny () {
    return decoding__namespace.readAny(this.restDecoder)
  }

  /**
   * @return {Uint8Array}
   */
  readBuf () {
    return decoding__namespace.readVarUint8Array(this.restDecoder)
  }

  /**
   * This is mainly here for legacy purposes.
   *
   * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
   *
   * @return {any}
   */
  readJSON () {
    return decoding__namespace.readAny(this.restDecoder)
  }

  /**
   * @return {string}
   */
  readKey () {
    const keyClock = this.keyClockDecoder.read();
    if (keyClock < this.keys.length) {
      return this.keys[keyClock]
    } else {
      const key = this.stringDecoder.read();
      this.keys.push(key);
      return key
    }
  }
}

class DSEncoderV1 {
  constructor () {
    this.restEncoder = encoding__namespace.createEncoder();
  }

  toUint8Array () {
    return encoding__namespace.toUint8Array(this.restEncoder)
  }

  resetDsCurVal () {
    // nop
  }

  /**
   * @param {number} clock
   */
  writeDsClock (clock) {
    encoding__namespace.writeVarUint(this.restEncoder, clock);
  }

  /**
   * @param {number} len
   */
  writeDsLen (len) {
    encoding__namespace.writeVarUint(this.restEncoder, len);
  }
}

class UpdateEncoderV1 extends DSEncoderV1 {
  /**
   * @param {ID} id
   */
  writeLeftID (id) {
    encoding__namespace.writeVarUint(this.restEncoder, id.client);
    encoding__namespace.writeVarUint(this.restEncoder, id.clock);
  }

  /**
   * @param {ID} id
   */
  writeRightID (id) {
    encoding__namespace.writeVarUint(this.restEncoder, id.client);
    encoding__namespace.writeVarUint(this.restEncoder, id.clock);
  }

  /**
   * Use writeClient and writeClock instead of writeID if possible.
   * @param {number} client
   */
  writeClient (client) {
    encoding__namespace.writeVarUint(this.restEncoder, client);
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeInfo (info) {
    encoding__namespace.writeUint8(this.restEncoder, info);
  }

  /**
   * @param {string} s
   */
  writeString (s) {
    encoding__namespace.writeVarString(this.restEncoder, s);
  }

  /**
   * @param {boolean} isYKey
   */
  writeParentInfo (isYKey) {
    encoding__namespace.writeVarUint(this.restEncoder, isYKey ? 1 : 0);
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeTypeRef (info) {
    encoding__namespace.writeVarUint(this.restEncoder, info);
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @param {number} len
   */
  writeLen (len) {
    encoding__namespace.writeVarUint(this.restEncoder, len);
  }

  /**
   * @param {any} any
   */
  writeAny (any) {
    encoding__namespace.writeAny(this.restEncoder, any);
  }

  /**
   * @param {Uint8Array} buf
   */
  writeBuf (buf) {
    encoding__namespace.writeVarUint8Array(this.restEncoder, buf);
  }

  /**
   * @param {any} embed
   */
  writeJSON (embed) {
    encoding__namespace.writeVarString(this.restEncoder, JSON.stringify(embed));
  }

  /**
   * @param {string} key
   */
  writeKey (key) {
    encoding__namespace.writeVarString(this.restEncoder, key);
  }
}

class DSEncoderV2 {
  constructor () {
    this.restEncoder = encoding__namespace.createEncoder(); // encodes all the rest / non-optimized
    this.dsCurrVal = 0;
  }

  toUint8Array () {
    return encoding__namespace.toUint8Array(this.restEncoder)
  }

  resetDsCurVal () {
    this.dsCurrVal = 0;
  }

  /**
   * @param {number} clock
   */
  writeDsClock (clock) {
    const diff = clock - this.dsCurrVal;
    this.dsCurrVal = clock;
    encoding__namespace.writeVarUint(this.restEncoder, diff);
  }

  /**
   * @param {number} len
   */
  writeDsLen (len) {
    if (len === 0) {
      error__namespace.unexpectedCase();
    }
    encoding__namespace.writeVarUint(this.restEncoder, len - 1);
    this.dsCurrVal += len;
  }
}

class UpdateEncoderV2 extends DSEncoderV2 {
  constructor () {
    super();
    /**
     * @type {Map<string,number>}
     */
    this.keyMap = new Map();
    /**
     * Refers to the next uniqe key-identifier to me used.
     * See writeKey method for more information.
     *
     * @type {number}
     */
    this.keyClock = 0;
    this.keyClockEncoder = new encoding__namespace.IntDiffOptRleEncoder();
    this.clientEncoder = new encoding__namespace.UintOptRleEncoder();
    this.leftClockEncoder = new encoding__namespace.IntDiffOptRleEncoder();
    this.rightClockEncoder = new encoding__namespace.IntDiffOptRleEncoder();
    this.infoEncoder = new encoding__namespace.RleEncoder(encoding__namespace.writeUint8);
    this.stringEncoder = new encoding__namespace.StringEncoder();
    this.parentInfoEncoder = new encoding__namespace.RleEncoder(encoding__namespace.writeUint8);
    this.typeRefEncoder = new encoding__namespace.UintOptRleEncoder();
    this.lenEncoder = new encoding__namespace.UintOptRleEncoder();
  }

  toUint8Array () {
    const encoder = encoding__namespace.createEncoder();
    encoding__namespace.writeVarUint(encoder, 0); // this is a feature flag that we might use in the future
    encoding__namespace.writeVarUint8Array(encoder, this.keyClockEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, this.clientEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, this.leftClockEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, this.rightClockEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, encoding__namespace.toUint8Array(this.infoEncoder));
    encoding__namespace.writeVarUint8Array(encoder, this.stringEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, encoding__namespace.toUint8Array(this.parentInfoEncoder));
    encoding__namespace.writeVarUint8Array(encoder, this.typeRefEncoder.toUint8Array());
    encoding__namespace.writeVarUint8Array(encoder, this.lenEncoder.toUint8Array());
    // @note The rest encoder is appended! (note the missing var)
    encoding__namespace.writeUint8Array(encoder, encoding__namespace.toUint8Array(this.restEncoder));
    return encoding__namespace.toUint8Array(encoder)
  }

  /**
   * @param {ID} id
   */
  writeLeftID (id) {
    this.clientEncoder.write(id.client);
    this.leftClockEncoder.write(id.clock);
  }

  /**
   * @param {ID} id
   */
  writeRightID (id) {
    this.clientEncoder.write(id.client);
    this.rightClockEncoder.write(id.clock);
  }

  /**
   * @param {number} client
   */
  writeClient (client) {
    this.clientEncoder.write(client);
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeInfo (info) {
    this.infoEncoder.write(info);
  }

  /**
   * @param {string} s
   */
  writeString (s) {
    this.stringEncoder.write(s);
  }

  /**
   * @param {boolean} isYKey
   */
  writeParentInfo (isYKey) {
    this.parentInfoEncoder.write(isYKey ? 1 : 0);
  }

  /**
   * @param {number} info An unsigned 8-bit integer
   */
  writeTypeRef (info) {
    this.typeRefEncoder.write(info);
  }

  /**
   * Write len of a struct - well suited for Opt RLE encoder.
   *
   * @param {number} len
   */
  writeLen (len) {
    this.lenEncoder.write(len);
  }

  /**
   * @param {any} any
   */
  writeAny (any) {
    encoding__namespace.writeAny(this.restEncoder, any);
  }

  /**
   * @param {Uint8Array} buf
   */
  writeBuf (buf) {
    encoding__namespace.writeVarUint8Array(this.restEncoder, buf);
  }

  /**
   * This is mainly here for legacy purposes.
   *
   * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
   *
   * @param {any} embed
   */
  writeJSON (embed) {
    encoding__namespace.writeAny(this.restEncoder, embed);
  }

  /**
   * Property keys are often reused. For example, in y-prosemirror the key `bold` might
   * occur very often. For a 3d application, the key `position` might occur very often.
   *
   * We cache these keys in a Map and refer to them via a unique number.
   *
   * @param {string} key
   */
  writeKey (key) {
    const clock = this.keyMap.get(key);
    if (clock === undefined) {
      /**
       * @todo uncomment to introduce this feature finally
       *
       * Background. The ContentFormat object was always encoded using writeKey, but the decoder used to use readString.
       * Furthermore, I forgot to set the keyclock. So everything was working fine.
       *
       * However, this feature here is basically useless as it is not being used (it actually only consumes extra memory).
       *
       * I don't know yet how to reintroduce this feature..
       *
       * Older clients won't be able to read updates when we reintroduce this feature. So this should probably be done using a flag.
       *
       */
      // this.keyMap.set(key, this.keyClock)
      this.keyClockEncoder.write(this.keyClock++);
      this.stringEncoder.write(key);
    } else {
      this.keyClockEncoder.write(clock);
    }
  }
}

/**
 * @module encoding
 */
/*
 * We use the first five bits in the info flag for determining the type of the struct.
 *
 * 0: GC
 * 1: Item with Deleted content
 * 2: Item with JSON content
 * 3: Item with Binary content
 * 4: Item with String content
 * 5: Item with Embed content (for richtext content)
 * 6: Item with Format content (a formatting marker for richtext content)
 * 7: Item with Type
 */


/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Array<GC|Item>} structs All structs by `client`
 * @param {number} client
 * @param {number} clock write structs starting with `ID(client,clock)`
 *
 * @function
 */
const writeStructs = (encoder, structs, client, clock) => {
  // write first id
  clock = math__namespace.max(clock, structs[0].id.clock); // make sure the first id exists
  const startNewStructs = findIndexSS(structs, clock);
  // write # encoded structs
  encoding__namespace.writeVarUint(encoder.restEncoder, structs.length - startNewStructs);
  encoder.writeClient(client);
  encoding__namespace.writeVarUint(encoder.restEncoder, clock);
  const firstStruct = structs[startNewStructs];
  // write first struct with an offset
  firstStruct.write(encoder, clock - firstStruct.id.clock);
  for (let i = startNewStructs + 1; i < structs.length; i++) {
    structs[i].write(encoder, 0);
  }
};

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 *
 * @private
 * @function
 */
const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm
  const sm = new Map();
  _sm.forEach((clock, client) => {
    // only write if new structs are available
    if (getState(store, client) > clock) {
      sm.set(client, clock);
    }
  });
  getStateVector(store).forEach((_clock, client) => {
    if (!_sm.has(client)) {
      sm.set(client, 0);
    }
  });
  // write # states that were updated
  encoding__namespace.writeVarUint(encoder.restEncoder, sm.size);
  // Write items with higher client ids first
  // This heavily improves the conflict algorithm.
  array__namespace.from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    writeStructs(encoder, /** @type {Array<GC|Item>} */ (store.clients.get(client)), client, clock);
  });
};

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder The decoder object to read data from.
 * @param {Doc} doc
 * @return {Map<number, { i: number, refs: Array<Item | GC> }>}
 *
 * @private
 * @function
 */
const readClientsStructRefs = (decoder, doc) => {
  /**
   * @type {Map<number, { i: number, refs: Array<Item | GC> }>}
   */
  const clientRefs = map__namespace.create();
  const numOfStateUpdates = decoding__namespace.readVarUint(decoder.restDecoder);
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding__namespace.readVarUint(decoder.restDecoder);
    /**
     * @type {Array<GC|Item>}
     */
    const refs = new Array(numberOfStructs);
    const client = decoder.readClient();
    let clock = decoding__namespace.readVarUint(decoder.restDecoder);
    // const start = performance.now()
    clientRefs.set(client, { i: 0, refs });
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo();
      switch (binary__namespace.BITS5 & info) {
        case 0: { // GC
          const len = decoder.readLen();
          refs[i] = new GC(createID(client, clock), len);
          clock += len;
          break
        }
        case 10: { // Skip Struct (nothing to apply)
          // @todo we could reduce the amount of checks by adding Skip struct to clientRefs so we know that something is missing.
          const len = decoding__namespace.readVarUint(decoder.restDecoder);
          refs[i] = new Skip(createID(client, clock), len);
          clock += len;
          break
        }
        default: { // Item with content
          /**
           * The optimized implementation doesn't use any variables because inlining variables is faster.
           * Below a non-optimized version is shown that implements the basic algorithm with
           * a few comments
           */
          const cantCopyParentInfo = (info & (binary__namespace.BIT7 | binary__namespace.BIT8)) === 0;
          // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
          // and we read the next string as parentYKey.
          // It indicates how we store/retrieve parent from `y.share`
          // @type {string|null}
          const struct = new Item(
            createID(client, clock),
            null, // left
            (info & binary__namespace.BIT8) === binary__namespace.BIT8 ? decoder.readLeftID() : null, // origin
            null, // right
            (info & binary__namespace.BIT7) === binary__namespace.BIT7 ? decoder.readRightID() : null, // right origin
            cantCopyParentInfo ? (decoder.readParentInfo() ? doc.get(decoder.readString()) : decoder.readLeftID()) : null, // parent
            cantCopyParentInfo && (info & binary__namespace.BIT6) === binary__namespace.BIT6 ? decoder.readString() : null, // parentSub
            readItemContent(decoder, info) // item content
          );
          /* A non-optimized implementation of the above algorithm:

          // The item that was originally to the left of this item.
          const origin = (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null
          // The item that was originally to the right of this item.
          const rightOrigin = (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null
          const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
          const hasParentYKey = cantCopyParentInfo ? decoder.readParentInfo() : false
          // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
          // and we read the next string as parentYKey.
          // It indicates how we store/retrieve parent from `y.share`
          // @type {string|null}
          const parentYKey = cantCopyParentInfo && hasParentYKey ? decoder.readString() : null

          const struct = new Item(
            createID(client, clock),
            null, // left
            origin, // origin
            null, // right
            rightOrigin, // right origin
            cantCopyParentInfo && !hasParentYKey ? decoder.readLeftID() : (parentYKey !== null ? doc.get(parentYKey) : null), // parent
            cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
            readItemContent(decoder, info) // item content
          )
          */
          refs[i] = struct;
          clock += struct.length;
        }
      }
    }
    // console.log('time to read: ', performance.now() - start) // @todo remove
  }
  return clientRefs
};

/**
 * Resume computing structs generated by struct readers.
 *
 * While there is something to do, we integrate structs in this order
 * 1. top element on stack, if stack is not empty
 * 2. next element from current struct reader (if empty, use next struct reader)
 *
 * If struct causally depends on another struct (ref.missing), we put next reader of
 * `ref.id.client` on top of stack.
 *
 * At some point we find a struct that has no causal dependencies,
 * then we start emptying the stack.
 *
 * It is not possible to have circles: i.e. struct1 (from client1) depends on struct2 (from client2)
 * depends on struct3 (from client1). Therefore the max stack size is eqaul to `structReaders.length`.
 *
 * This method is implemented in a way so that we can resume computation if this update
 * causally depends on another update.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {Map<number, { i: number, refs: (GC | Item)[] }>} clientsStructRefs
 * @return { null | { update: Uint8Array, missing: Map<number,number> } }
 *
 * @private
 * @function
 */
const integrateStructs = (transaction, store, clientsStructRefs) => {
  /**
   * @type {Array<Item | GC>}
   */
  const stack = [];
  // sort them so that we take the higher id first, in case of conflicts the lower id will probably not conflict with the id from the higher user.
  let clientsStructRefsIds = array__namespace.from(clientsStructRefs.keys()).sort((a, b) => a - b);
  if (clientsStructRefsIds.length === 0) {
    return null
  }
  const getNextStructTarget = () => {
    if (clientsStructRefsIds.length === 0) {
      return null
    }
    let nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]));
    while (nextStructsTarget.refs.length === nextStructsTarget.i) {
      clientsStructRefsIds.pop();
      if (clientsStructRefsIds.length > 0) {
        nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */ (clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]));
      } else {
        return null
      }
    }
    return nextStructsTarget
  };
  let curStructsTarget = getNextStructTarget();
  if (curStructsTarget === null) {
    return null
  }

  /**
   * @type {StructStore}
   */
  const restStructs = new StructStore();
  const missingSV = new Map();
  /**
   * @param {number} client
   * @param {number} clock
   */
  const updateMissingSv = (client, clock) => {
    const mclock = missingSV.get(client);
    if (mclock == null || mclock > clock) {
      missingSV.set(client, clock);
    }
  };
  /**
   * @type {GC|Item}
   */
  let stackHead = /** @type {any} */ (curStructsTarget).refs[/** @type {any} */ (curStructsTarget).i++];
  // caching the state because it is used very often
  const state = new Map();

  const addStackToRestSS = () => {
    for (const item of stack) {
      const client = item.id.client;
      const unapplicableItems = clientsStructRefs.get(client);
      if (unapplicableItems) {
        // decrement because we weren't able to apply previous operation
        unapplicableItems.i--;
        restStructs.clients.set(client, unapplicableItems.refs.slice(unapplicableItems.i));
        clientsStructRefs.delete(client);
        unapplicableItems.i = 0;
        unapplicableItems.refs = [];
      } else {
        // item was the last item on clientsStructRefs and the field was already cleared. Add item to restStructs and continue
        restStructs.clients.set(client, [item]);
      }
      // remove client from clientsStructRefsIds to prevent users from applying the same update again
      clientsStructRefsIds = clientsStructRefsIds.filter(c => c !== client);
    }
    stack.length = 0;
  };

  // iterate over all struct readers until we are done
  while (true) {
    if (stackHead.constructor !== Skip) {
      const localClock = map__namespace.setIfUndefined(state, stackHead.id.client, () => getState(store, stackHead.id.client));
      const offset = localClock - stackHead.id.clock;
      if (offset < 0) {
        // update from the same client is missing
        stack.push(stackHead);
        updateMissingSv(stackHead.id.client, stackHead.id.clock - 1);
        // hid a dead wall, add all items from stack to restSS
        addStackToRestSS();
      } else {
        const missing = stackHead.getMissing(transaction, store);
        if (missing !== null) {
          stack.push(stackHead);
          // get the struct reader that has the missing struct
          /**
           * @type {{ refs: Array<GC|Item>, i: number }}
           */
          const structRefs = clientsStructRefs.get(/** @type {number} */ (missing)) || { refs: [], i: 0 };
          if (structRefs.refs.length === structRefs.i) {
            // This update message causally depends on another update message that doesn't exist yet
            updateMissingSv(/** @type {number} */ (missing), getState(store, missing));
            addStackToRestSS();
          } else {
            stackHead = structRefs.refs[structRefs.i++];
            continue
          }
        } else if (offset === 0 || offset < stackHead.length) {
          // all fine, apply the stackhead
          stackHead.integrate(transaction, offset);
          state.set(stackHead.id.client, stackHead.id.clock + stackHead.length);
        }
      }
    }
    // iterate to next stackHead
    if (stack.length > 0) {
      stackHead = /** @type {GC|Item} */ (stack.pop());
    } else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) {
      stackHead = /** @type {GC|Item} */ (curStructsTarget.refs[curStructsTarget.i++]);
    } else {
      curStructsTarget = getNextStructTarget();
      if (curStructsTarget === null) {
        // we are done!
        break
      } else {
        stackHead = /** @type {GC|Item} */ (curStructsTarget.refs[curStructsTarget.i++]);
      }
    }
  }
  if (restStructs.clients.size > 0) {
    const encoder = new UpdateEncoderV2();
    writeClientsStructs(encoder, restStructs, new Map());
    // write empty deleteset
    // writeDeleteSet(encoder, new DeleteSet())
    encoding__namespace.writeVarUint(encoder.restEncoder, 0); // => no need for an extra function call, just write 0 deletes
    return { missing: missingSV, update: encoder.toUint8Array() }
  }
  return null
};

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
const writeStructsFromTransaction = (encoder, transaction) => writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState);

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {UpdateDecoderV1 | UpdateDecoderV2} [structDecoder]
 *
 * @function
 */
const readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) =>
  transact(ydoc, transaction => {
    // force that transaction.local is set to non-local
    transaction.local = false;
    let retry = false;
    const doc = transaction.doc;
    const store = doc.store;
    // let start = performance.now()
    const ss = readClientsStructRefs(structDecoder, doc);
    // console.log('time to read structs: ', performance.now() - start) // @todo remove
    // start = performance.now()
    // console.log('time to merge: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const restStructs = integrateStructs(transaction, store, ss);
    const pending = store.pendingStructs;
    if (pending) {
      // check if we can apply something
      for (const [client, clock] of pending.missing) {
        if (clock < getState(store, client)) {
          retry = true;
          break
        }
      }
      if (restStructs) {
        // merge restStructs into store.pending
        for (const [client, clock] of restStructs.missing) {
          const mclock = pending.missing.get(client);
          if (mclock == null || mclock > clock) {
            pending.missing.set(client, clock);
          }
        }
        pending.update = mergeUpdatesV2([pending.update, restStructs.update]);
      }
    } else {
      store.pendingStructs = restStructs;
    }
    // console.log('time to integrate: ', performance.now() - start) // @todo remove
    // start = performance.now()
    const dsRest = readAndApplyDeleteSet(structDecoder, transaction, store);
    if (store.pendingDs) {
      // @todo we could make a lower-bound state-vector check as we do above
      const pendingDSUpdate = new UpdateDecoderV2(decoding__namespace.createDecoder(store.pendingDs));
      decoding__namespace.readVarUint(pendingDSUpdate.restDecoder); // read 0 structs, because we only encode deletes in pendingdsupdate
      const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store);
      if (dsRest && dsRest2) {
        // case 1: ds1 != null && ds2 != null
        store.pendingDs = mergeUpdatesV2([dsRest, dsRest2]);
      } else {
        // case 2: ds1 != null
        // case 3: ds2 != null
        // case 4: ds1 == null && ds2 == null
        store.pendingDs = dsRest || dsRest2;
      }
    } else {
      // Either dsRest == null && pendingDs == null OR dsRest != null
      store.pendingDs = dsRest;
    }
    // console.log('time to cleanup: ', performance.now() - start) // @todo remove
    // start = performance.now()

    // console.log('time to resume delete readers: ', performance.now() - start) // @todo remove
    // start = performance.now()
    if (retry) {
      const update = /** @type {{update: Uint8Array}} */ (store.pendingStructs).update;
      store.pendingStructs = null;
      applyUpdateV2(transaction.doc, update);
    }
  }, transactionOrigin, false);

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts a decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
const readUpdate$1 = (decoder, ydoc, transactionOrigin) => readUpdateV2(decoder, ydoc, transactionOrigin, new UpdateDecoderV1(decoder));

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 *
 * @function
 */
const applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
  const decoder = decoding__namespace.createDecoder(update);
  readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder));
};

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
const applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1);

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  writeClientsStructs(encoder, doc.store, targetStateVector);
  writeDeleteSet(encoder, createDeleteSetFromStructStore(doc.store));
};

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @param {UpdateEncoderV1 | UpdateEncoderV2} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
const encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder = new UpdateEncoderV2()) => {
  const targetStateVector = decodeStateVector(encodedTargetStateVector);
  writeStateAsUpdate(encoder, doc, targetStateVector);
  const updates = [encoder.toUint8Array()];
  // also add the pending updates (if there are any)
  if (doc.store.pendingDs) {
    updates.push(doc.store.pendingDs);
  }
  if (doc.store.pendingStructs) {
    updates.push(diffUpdateV2(doc.store.pendingStructs.update, encodedTargetStateVector));
  }
  if (updates.length > 1) {
    if (encoder.constructor === UpdateEncoderV1) {
      return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)))
    } else if (encoder.constructor === UpdateEncoderV2) {
      return mergeUpdatesV2(updates)
    }
  }
  return updates[0]
};

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array}
 *
 * @function
 */
const encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1());

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {DSDecoderV1 | DSDecoderV2} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
const readStateVector = decoder => {
  const ss = new Map();
  const ssLength = decoding__namespace.readVarUint(decoder.restDecoder);
  for (let i = 0; i < ssLength; i++) {
    const client = decoding__namespace.readVarUint(decoder.restDecoder);
    const clock = decoding__namespace.readVarUint(decoder.restDecoder);
    ss.set(client, clock);
  }
  return ss
};

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
// export const decodeStateVectorV2 = decodedState => readStateVector(new DSDecoderV2(decoding.createDecoder(decodedState)))

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
const decodeStateVector = decodedState => readStateVector(new DSDecoderV1(decoding__namespace.createDecoder(decodedState)));

/**
 * @param {DSEncoderV1 | DSEncoderV2} encoder
 * @param {Map<number,number>} sv
 * @function
 */
const writeStateVector = (encoder, sv) => {
  encoding__namespace.writeVarUint(encoder.restEncoder, sv.size);
  array__namespace.from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
    encoding__namespace.writeVarUint(encoder.restEncoder, client); // @todo use a special client decoder that is based on mapping
    encoding__namespace.writeVarUint(encoder.restEncoder, clock);
  });
  return encoder
};

/**
 * @param {DSEncoderV1 | DSEncoderV2} encoder
 * @param {Doc} doc
 *
 * @function
 */
const writeDocumentStateVector = (encoder, doc) => writeStateVector(encoder, getStateVector(doc.store));

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @param {DSEncoderV1 | DSEncoderV2} [encoder]
 * @return {Uint8Array}
 *
 * @function
 */
const encodeStateVectorV2 = (doc, encoder = new DSEncoderV2()) => {
  if (doc instanceof Map) {
    writeStateVector(encoder, doc);
  } else {
    writeDocumentStateVector(encoder, doc);
  }
  return encoder.toUint8Array()
};

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc|Map<number,number>} doc
 * @return {Uint8Array}
 *
 * @function
 */
const encodeStateVector = doc => encodeStateVectorV2(doc, new DSEncoderV1());

/**
 * General event handler implementation.
 *
 * @template ARG0, ARG1
 *
 * @private
 */
class EventHandler {
  constructor () {
    /**
     * @type {Array<function(ARG0, ARG1):void>}
     */
    this.l = [];
  }
}

/**
 * @template ARG0,ARG1
 * @returns {EventHandler<ARG0,ARG1>}
 *
 * @private
 * @function
 */
const createEventHandler = () => new EventHandler();

/**
 * Adds an event listener that is called when
 * {@link EventHandler#callEventListeners} is called.
 *
 * @template ARG0,ARG1
 * @param {EventHandler<ARG0,ARG1>} eventHandler
 * @param {function(ARG0,ARG1):void} f The event handler.
 *
 * @private
 * @function
 */
const addEventHandlerListener = (eventHandler, f) =>
  eventHandler.l.push(f);

/**
 * Removes an event listener.
 *
 * @template ARG0,ARG1
 * @param {EventHandler<ARG0,ARG1>} eventHandler
 * @param {function(ARG0,ARG1):void} f The event handler that was added with
 *                     {@link EventHandler#addEventListener}
 *
 * @private
 * @function
 */
const removeEventHandlerListener = (eventHandler, f) => {
  const l = eventHandler.l;
  const len = l.length;
  eventHandler.l = l.filter(g => f !== g);
  if (len === eventHandler.l.length) {
    console.error('[yjs] Tried to remove event handler that doesn\'t exist.');
  }
};

/**
 * Call all event listeners that were added via
 * {@link EventHandler#addEventListener}.
 *
 * @template ARG0,ARG1
 * @param {EventHandler<ARG0,ARG1>} eventHandler
 * @param {ARG0} arg0
 * @param {ARG1} arg1
 *
 * @private
 * @function
 */
const callEventHandlerListeners = (eventHandler, arg0, arg1) =>
  f__namespace.callAll(eventHandler.l, [arg0, arg1]);

class ID {
  /**
   * @param {number} client client id
   * @param {number} clock unique per client id, continuous number
   */
  constructor (client, clock) {
    /**
     * Client id
     * @type {number}
     */
    this.client = client;
    /**
     * unique per client id, continuous number
     * @type {number}
     */
    this.clock = clock;
  }
}

/**
 * @param {ID | null} a
 * @param {ID | null} b
 * @return {boolean}
 *
 * @function
 */
const compareIDs = (a, b) => a === b || (a !== null && b !== null && a.client === b.client && a.clock === b.clock);

/**
 * @param {number} client
 * @param {number} clock
 *
 * @private
 * @function
 */
const createID = (client, clock) => new ID(client, clock);

/**
 * @param {encoding.Encoder} encoder
 * @param {ID} id
 *
 * @private
 * @function
 */
const writeID = (encoder, id) => {
  encoding__namespace.writeVarUint(encoder, id.client);
  encoding__namespace.writeVarUint(encoder, id.clock);
};

/**
 * Read ID.
 * * If first varUint read is 0xFFFFFF a RootID is returned.
 * * Otherwise an ID is returned
 *
 * @param {decoding.Decoder} decoder
 * @return {ID}
 *
 * @private
 * @function
 */
const readID = decoder =>
  createID(decoding__namespace.readVarUint(decoder), decoding__namespace.readVarUint(decoder));

/**
 * The top types are mapped from y.share.get(keyname) => type.
 * `type` does not store any information about the `keyname`.
 * This function finds the correct `keyname` for `type` and throws otherwise.
 *
 * @param {AbstractType<any>} type
 * @return {string}
 *
 * @private
 * @function
 */
const findRootTypeKey = type => {
  // @ts-ignore _y must be defined, otherwise unexpected case
  for (const [key, value] of type.doc.share.entries()) {
    if (value === type) {
      return key
    }
  }
  throw error__namespace.unexpectedCase()
};

/**
 * Check if `parent` is a parent of `child`.
 *
 * @param {AbstractType<any>} parent
 * @param {Item|null} child
 * @return {Boolean} Whether `parent` is a parent of `child`.
 *
 * @private
 * @function
 */
const isParentOf = (parent, child) => {
  while (child !== null) {
    if (child.parent === parent) {
      return true
    }
    child = /** @type {AbstractType<any>} */ (child.parent)._item;
  }
  return false
};

/**
 * Convenient helper to log type information.
 *
 * Do not use in productive systems as the output can be immense!
 *
 * @param {AbstractType<any>} type
 */
const logType = type => {
  const res = [];
  let n = type._start;
  while (n) {
    res.push(n);
    n = n.right;
  }
  console.log('Children: ', res);
  console.log('Children content: ', res.filter(m => !m.deleted).map(m => m.content));
};

class PermanentUserData {
  /**
   * @param {Doc} doc
   * @param {YMap<any>} [storeType]
   */
  constructor (doc, storeType = doc.getMap('users')) {
    /**
     * @type {Map<string,DeleteSet>}
     */
    const dss = new Map();
    this.yusers = storeType;
    this.doc = doc;
    /**
     * Maps from clientid to userDescription
     *
     * @type {Map<number,string>}
     */
    this.clients = new Map();
    this.dss = dss;
    /**
     * @param {YMap<any>} user
     * @param {string} userDescription
     */
    const initUser = (user, userDescription) => {
      /**
       * @type {YArray<Uint8Array>}
       */
      const ds = user.get('ds');
      const ids = user.get('ids');
      const addClientId = /** @param {number} clientid */ clientid => this.clients.set(clientid, userDescription);
      ds.observe(/** @param {YArrayEvent<any>} event */ event => {
        event.changes.added.forEach(item => {
          item.content.getContent().forEach(encodedDs => {
            if (encodedDs instanceof Uint8Array) {
              this.dss.set(userDescription, mergeDeleteSets([this.dss.get(userDescription) || createDeleteSet(), readDeleteSet(new DSDecoderV1(decoding__namespace.createDecoder(encodedDs)))]));
            }
          });
        });
      });
      this.dss.set(userDescription, mergeDeleteSets(ds.map(encodedDs => readDeleteSet(new DSDecoderV1(decoding__namespace.createDecoder(encodedDs))))));
      ids.observe(/** @param {YArrayEvent<any>} event */ event =>
        event.changes.added.forEach(item => item.content.getContent().forEach(addClientId))
      );
      ids.forEach(addClientId);
    };
    // observe users
    storeType.observe(event => {
      event.keysChanged.forEach(userDescription =>
        initUser(storeType.get(userDescription), userDescription)
      );
    });
    // add intial data
    storeType.forEach(initUser);
  }

  /**
   * @param {Doc} doc
   * @param {number} clientid
   * @param {string} userDescription
   * @param {Object} conf
   * @param {function(Transaction, DeleteSet):boolean} [conf.filter]
   */
  setUserMapping (doc, clientid, userDescription, { filter = () => true } = {}) {
    const users = this.yusers;
    let user = users.get(userDescription);
    if (!user) {
      user = new YMap();
      user.set('ids', new YArray());
      user.set('ds', new YArray());
      users.set(userDescription, user);
    }
    user.get('ids').push([clientid]);
    users.observe(_event => {
      setTimeout(() => {
        const userOverwrite = users.get(userDescription);
        if (userOverwrite !== user) {
          // user was overwritten, port all data over to the next user object
          // @todo Experiment with Y.Sets here
          user = userOverwrite;
          // @todo iterate over old type
          this.clients.forEach((_userDescription, clientid) => {
            if (userDescription === _userDescription) {
              user.get('ids').push([clientid]);
            }
          });
          const encoder = new DSEncoderV1();
          const ds = this.dss.get(userDescription);
          if (ds) {
            writeDeleteSet(encoder, ds);
            user.get('ds').push([encoder.toUint8Array()]);
          }
        }
      }, 0);
    });
    doc.on('afterTransaction', /** @param {Transaction} transaction */ transaction => {
      setTimeout(() => {
        const yds = user.get('ds');
        const ds = transaction.deleteSet;
        if (transaction.local && ds.clients.size > 0 && filter(transaction, ds)) {
          const encoder = new DSEncoderV1();
          writeDeleteSet(encoder, ds);
          yds.push([encoder.toUint8Array()]);
        }
      });
    });
  }

  /**
   * @param {number} clientid
   * @return {any}
   */
  getUserByClientId (clientid) {
    return this.clients.get(clientid) || null
  }

  /**
   * @param {ID} id
   * @return {string | null}
   */
  getUserByDeletedId (id) {
    for (const [userDescription, ds] of this.dss.entries()) {
      if (isDeleted(ds, id)) {
        return userDescription
      }
    }
    return null
  }
}

/**
 * A relative position is based on the Yjs model and is not affected by document changes.
 * E.g. If you place a relative position before a certain character, it will always point to this character.
 * If you place a relative position at the end of a type, it will always point to the end of the type.
 *
 * A numeric position is often unsuited for user selections, because it does not change when content is inserted
 * before or after.
 *
 * ```Insert(0, 'x')('a|bc') = 'xa|bc'``` Where | is the relative position.
 *
 * One of the properties must be defined.
 *
 * @example
 *   // Current cursor position is at position 10
 *   const relativePosition = createRelativePositionFromIndex(yText, 10)
 *   // modify yText
 *   yText.insert(0, 'abc')
 *   yText.delete(3, 10)
 *   // Compute the cursor position
 *   const absolutePosition = createAbsolutePositionFromRelativePosition(y, relativePosition)
 *   absolutePosition.type === yText // => true
 *   console.log('cursor location is ' + absolutePosition.index) // => cursor location is 3
 *
 */
class RelativePosition {
  /**
   * @param {ID|null} type
   * @param {string|null} tname
   * @param {ID|null} item
   * @param {number} assoc
   */
  constructor (type, tname, item, assoc = 0) {
    /**
     * @type {ID|null}
     */
    this.type = type;
    /**
     * @type {string|null}
     */
    this.tname = tname;
    /**
     * @type {ID | null}
     */
    this.item = item;
    /**
     * A relative position is associated to a specific character. By default
     * assoc >= 0, the relative position is associated to the character
     * after the meant position.
     * I.e. position 1 in 'ab' is associated to character 'b'.
     *
     * If assoc < 0, then the relative position is associated to the caharacter
     * before the meant position.
     *
     * @type {number}
     */
    this.assoc = assoc;
  }
}

/**
 * @param {RelativePosition} rpos
 * @return {any}
 */
const relativePositionToJSON = rpos => {
  const json = {};
  if (rpos.type) {
    json.type = rpos.type;
  }
  if (rpos.tname) {
    json.tname = rpos.tname;
  }
  if (rpos.item) {
    json.item = rpos.item;
  }
  if (rpos.assoc != null) {
    json.assoc = rpos.assoc;
  }
  return json
};

/**
 * @param {any} json
 * @return {RelativePosition}
 *
 * @function
 */
const createRelativePositionFromJSON = json => new RelativePosition(json.type == null ? null : createID(json.type.client, json.type.clock), json.tname ?? null, json.item == null ? null : createID(json.item.client, json.item.clock), json.assoc == null ? 0 : json.assoc);

class AbsolutePosition {
  /**
   * @param {AbstractType<any>} type
   * @param {number} index
   * @param {number} [assoc]
   */
  constructor (type, index, assoc = 0) {
    /**
     * @type {AbstractType<any>}
     */
    this.type = type;
    /**
     * @type {number}
     */
    this.index = index;
    this.assoc = assoc;
  }
}

/**
 * @param {AbstractType<any>} type
 * @param {number} index
 * @param {number} [assoc]
 *
 * @function
 */
const createAbsolutePosition = (type, index, assoc = 0) => new AbsolutePosition(type, index, assoc);

/**
 * @param {AbstractType<any>} type
 * @param {ID|null} item
 * @param {number} [assoc]
 *
 * @function
 */
const createRelativePosition = (type, item, assoc) => {
  let typeid = null;
  let tname = null;
  if (type._item === null) {
    tname = findRootTypeKey(type);
  } else {
    typeid = createID(type._item.id.client, type._item.id.clock);
  }
  return new RelativePosition(typeid, tname, item, assoc)
};

/**
 * Create a relativePosition based on a absolute position.
 *
 * @param {AbstractType<any>} type The base type (e.g. YText or YArray).
 * @param {number} index The absolute position.
 * @param {number} [assoc]
 * @return {RelativePosition}
 *
 * @function
 */
const createRelativePositionFromTypeIndex = (type, index, assoc = 0) => {
  let t = type._start;
  if (assoc < 0) {
    // associated to the left character or the beginning of a type, increment index if possible.
    if (index === 0) {
      return createRelativePosition(type, null, assoc)
    }
    index--;
  }
  while (t !== null) {
    if (!t.deleted && t.countable) {
      if (t.length > index) {
        // case 1: found position somewhere in the linked list
        return createRelativePosition(type, createID(t.id.client, t.id.clock + index), assoc)
      }
      index -= t.length;
    }
    if (t.right === null && assoc < 0) {
      // left-associated position, return last available id
      return createRelativePosition(type, t.lastId, assoc)
    }
    t = t.right;
  }
  return createRelativePosition(type, null, assoc)
};

/**
 * @param {encoding.Encoder} encoder
 * @param {RelativePosition} rpos
 *
 * @function
 */
const writeRelativePosition = (encoder, rpos) => {
  const { type, tname, item, assoc } = rpos;
  if (item !== null) {
    encoding__namespace.writeVarUint(encoder, 0);
    writeID(encoder, item);
  } else if (tname !== null) {
    // case 2: found position at the end of the list and type is stored in y.share
    encoding__namespace.writeUint8(encoder, 1);
    encoding__namespace.writeVarString(encoder, tname);
  } else if (type !== null) {
    // case 3: found position at the end of the list and type is attached to an item
    encoding__namespace.writeUint8(encoder, 2);
    writeID(encoder, type);
  } else {
    throw error__namespace.unexpectedCase()
  }
  encoding__namespace.writeVarInt(encoder, assoc);
  return encoder
};

/**
 * @param {RelativePosition} rpos
 * @return {Uint8Array}
 */
const encodeRelativePosition = rpos => {
  const encoder = encoding__namespace.createEncoder();
  writeRelativePosition(encoder, rpos);
  return encoding__namespace.toUint8Array(encoder)
};

/**
 * @param {decoding.Decoder} decoder
 * @return {RelativePosition}
 *
 * @function
 */
const readRelativePosition = decoder => {
  let type = null;
  let tname = null;
  let itemID = null;
  switch (decoding__namespace.readVarUint(decoder)) {
    case 0:
      // case 1: found position somewhere in the linked list
      itemID = readID(decoder);
      break
    case 1:
      // case 2: found position at the end of the list and type is stored in y.share
      tname = decoding__namespace.readVarString(decoder);
      break
    case 2: {
      // case 3: found position at the end of the list and type is attached to an item
      type = readID(decoder);
    }
  }
  const assoc = decoding__namespace.hasContent(decoder) ? decoding__namespace.readVarInt(decoder) : 0;
  return new RelativePosition(type, tname, itemID, assoc)
};

/**
 * @param {Uint8Array} uint8Array
 * @return {RelativePosition}
 */
const decodeRelativePosition = uint8Array => readRelativePosition(decoding__namespace.createDecoder(uint8Array));

/**
 * Transform a relative position to an absolute position.
 *
 * If you want to share the relative position with other users, you should set
 * `followUndoneDeletions` to false to get consistent results across all clients.
 *
 * When calculating the absolute position, we try to follow the "undone deletions". This yields
 * better results for the user who performed undo. However, only the user who performed the undo
 * will get the better results, the other users don't know which operations recreated a deleted
 * range of content. There is more information in this ticket: https://github.com/yjs/yjs/issues/638
 *
 * @param {RelativePosition} rpos
 * @param {Doc} doc
 * @param {boolean} followUndoneDeletions - whether to follow undone deletions - see https://github.com/yjs/yjs/issues/638
 * @return {AbsolutePosition|null}
 *
 * @function
 */
const createAbsolutePositionFromRelativePosition = (rpos, doc, followUndoneDeletions = true) => {
  const store = doc.store;
  const rightID = rpos.item;
  const typeID = rpos.type;
  const tname = rpos.tname;
  const assoc = rpos.assoc;
  let type = null;
  let index = 0;
  if (rightID !== null) {
    if (getState(store, rightID.client) <= rightID.clock) {
      return null
    }
    const res = followUndoneDeletions ? followRedone(store, rightID) : { item: getItem(store, rightID), diff: 0 };
    const right = res.item;
    if (!(right instanceof Item)) {
      return null
    }
    type = /** @type {AbstractType<any>} */ (right.parent);
    if (type._item === null || !type._item.deleted) {
      index = (right.deleted || !right.countable) ? 0 : (res.diff + (assoc >= 0 ? 0 : 1)); // adjust position based on left association if necessary
      let n = right.left;
      while (n !== null) {
        if (!n.deleted && n.countable) {
          index += n.length;
        }
        n = n.left;
      }
    }
  } else {
    if (tname !== null) {
      type = doc.get(tname);
    } else if (typeID !== null) {
      if (getState(store, typeID.client) <= typeID.clock) {
        // type does not exist yet
        return null
      }
      const { item } = followUndoneDeletions ? followRedone(store, typeID) : { item: getItem(store, typeID) };
      if (item instanceof Item && item.content instanceof ContentType) {
        type = item.content.type;
      } else {
        // struct is garbage collected
        return null
      }
    } else {
      throw error__namespace.unexpectedCase()
    }
    if (assoc >= 0) {
      index = type._length;
    } else {
      index = 0;
    }
  }
  return createAbsolutePosition(type, index, rpos.assoc)
};

/**
 * @param {RelativePosition|null} a
 * @param {RelativePosition|null} b
 * @return {boolean}
 *
 * @function
 */
const compareRelativePositions = (a, b) => a === b || (
  a !== null && b !== null && a.tname === b.tname && compareIDs(a.item, b.item) && compareIDs(a.type, b.type) && a.assoc === b.assoc
);

class Snapshot {
  /**
   * @param {DeleteSet} ds
   * @param {Map<number,number>} sv state map
   */
  constructor (ds, sv) {
    /**
     * @type {DeleteSet}
     */
    this.ds = ds;
    /**
     * State Map
     * @type {Map<number,number>}
     */
    this.sv = sv;
  }
}

/**
 * @param {Snapshot} snap1
 * @param {Snapshot} snap2
 * @return {boolean}
 */
const equalSnapshots = (snap1, snap2) => {
  const ds1 = snap1.ds.clients;
  const ds2 = snap2.ds.clients;
  const sv1 = snap1.sv;
  const sv2 = snap2.sv;
  if (sv1.size !== sv2.size || ds1.size !== ds2.size) {
    return false
  }
  for (const [key, value] of sv1.entries()) {
    if (sv2.get(key) !== value) {
      return false
    }
  }
  for (const [client, dsitems1] of ds1.entries()) {
    const dsitems2 = ds2.get(client) || [];
    if (dsitems1.length !== dsitems2.length) {
      return false
    }
    for (let i = 0; i < dsitems1.length; i++) {
      const dsitem1 = dsitems1[i];
      const dsitem2 = dsitems2[i];
      if (dsitem1.clock !== dsitem2.clock || dsitem1.len !== dsitem2.len) {
        return false
      }
    }
  }
  return true
};

/**
 * @param {Snapshot} snapshot
 * @param {DSEncoderV1 | DSEncoderV2} [encoder]
 * @return {Uint8Array}
 */
const encodeSnapshotV2 = (snapshot, encoder = new DSEncoderV2()) => {
  writeDeleteSet(encoder, snapshot.ds);
  writeStateVector(encoder, snapshot.sv);
  return encoder.toUint8Array()
};

/**
 * @param {Snapshot} snapshot
 * @return {Uint8Array}
 */
const encodeSnapshot = snapshot => encodeSnapshotV2(snapshot, new DSEncoderV1());

/**
 * @param {Uint8Array} buf
 * @param {DSDecoderV1 | DSDecoderV2} [decoder]
 * @return {Snapshot}
 */
const decodeSnapshotV2 = (buf, decoder = new DSDecoderV2(decoding__namespace.createDecoder(buf))) => {
  return new Snapshot(readDeleteSet(decoder), readStateVector(decoder))
};

/**
 * @param {Uint8Array} buf
 * @return {Snapshot}
 */
const decodeSnapshot = buf => decodeSnapshotV2(buf, new DSDecoderV1(decoding__namespace.createDecoder(buf)));

/**
 * @param {DeleteSet} ds
 * @param {Map<number,number>} sm
 * @return {Snapshot}
 */
const createSnapshot = (ds, sm) => new Snapshot(ds, sm);

const emptySnapshot = createSnapshot(createDeleteSet(), new Map());

/**
 * @param {Doc} doc
 * @return {Snapshot}
 */
const snapshot$1 = doc => createSnapshot(createDeleteSetFromStructStore(doc.store), getStateVector(doc.store));

/**
 * @param {Item} item
 * @param {Snapshot|undefined} snapshot
 *
 * @protected
 * @function
 */
const isVisible = (item, snapshot) => snapshot === undefined
  ? !item.deleted
  : snapshot.sv.has(item.id.client) && (snapshot.sv.get(item.id.client) || 0) > item.id.clock && !isDeleted(snapshot.ds, item.id);

/**
 * @param {Transaction} transaction
 * @param {Snapshot} snapshot
 */
const splitSnapshotAffectedStructs = (transaction, snapshot) => {
  const meta = map__namespace.setIfUndefined(transaction.meta, splitSnapshotAffectedStructs, set__namespace.create);
  const store = transaction.doc.store;
  // check if we already split for this snapshot
  if (!meta.has(snapshot)) {
    snapshot.sv.forEach((clock, client) => {
      if (clock < getState(store, client)) {
        getItemCleanStart(transaction, createID(client, clock));
      }
    });
    iterateDeletedStructs(transaction, snapshot.ds, _item => {});
    meta.add(snapshot);
  }
};

/**
 * @example
 *  const ydoc = new Y.Doc({ gc: false })
 *  ydoc.getText().insert(0, 'world!')
 *  const snapshot = Y.snapshot(ydoc)
 *  ydoc.getText().insert(0, 'hello ')
 *  const restored = Y.createDocFromSnapshot(ydoc, snapshot)
 *  assert(restored.getText().toString() === 'world!')
 *
 * @param {Doc} originDoc
 * @param {Snapshot} snapshot
 * @param {Doc} [newDoc] Optionally, you may define the Yjs document that receives the data from originDoc
 * @return {Doc}
 */
const createDocFromSnapshot = (originDoc, snapshot, newDoc = new Doc()) => {
  if (originDoc.gc) {
    // we should not try to restore a GC-ed document, because some of the restored items might have their content deleted
    throw new Error('Garbage-collection must be disabled in `originDoc`!')
  }
  const { sv, ds } = snapshot;

  const encoder = new UpdateEncoderV2();
  originDoc.transact(transaction => {
    let size = 0;
    sv.forEach(clock => {
      if (clock > 0) {
        size++;
      }
    });
    encoding__namespace.writeVarUint(encoder.restEncoder, size);
    // splitting the structs before writing them to the encoder
    for (const [client, clock] of sv) {
      if (clock === 0) {
        continue
      }
      if (clock < getState(originDoc.store, client)) {
        getItemCleanStart(transaction, createID(client, clock));
      }
      const structs = originDoc.store.clients.get(client) || [];
      const lastStructIndex = findIndexSS(structs, clock - 1);
      // write # encoded structs
      encoding__namespace.writeVarUint(encoder.restEncoder, lastStructIndex + 1);
      encoder.writeClient(client);
      // first clock written is 0
      encoding__namespace.writeVarUint(encoder.restEncoder, 0);
      for (let i = 0; i <= lastStructIndex; i++) {
        structs[i].write(encoder, 0);
      }
    }
    writeDeleteSet(encoder, ds);
  });

  applyUpdateV2(newDoc, encoder.toUint8Array(), 'snapshot');
  return newDoc
};

/**
 * @param {Snapshot} snapshot
 * @param {Uint8Array} update
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} [YDecoder]
 */
const snapshotContainsUpdateV2 = (snapshot, update, YDecoder = UpdateDecoderV2) => {
  const updateDecoder = new YDecoder(decoding__namespace.createDecoder(update));
  const lazyDecoder = new LazyStructReader(updateDecoder, false);
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    if ((snapshot.sv.get(curr.id.client) || 0) < curr.id.clock + curr.length) {
      return false
    }
  }
  const mergedDS = mergeDeleteSets([snapshot.ds, readDeleteSet(updateDecoder)]);
  return equalDeleteSets(snapshot.ds, mergedDS)
};

/**
 * @param {Snapshot} snapshot
 * @param {Uint8Array} update
 */
const snapshotContainsUpdate = (snapshot, update) => snapshotContainsUpdateV2(snapshot, update, UpdateDecoderV1);

class StructStore {
  constructor () {
    /**
     * @type {Map<number,Array<GC|Item>>}
     */
    this.clients = new Map();
    /**
     * @type {null | { missing: Map<number, number>, update: Uint8Array }}
     */
    this.pendingStructs = null;
    /**
     * @type {null | Uint8Array}
     */
    this.pendingDs = null;
  }
}

/**
 * Return the states as a Map<client,clock>.
 * Note that clock refers to the next expected clock id.
 *
 * @param {StructStore} store
 * @return {Map<number,number>}
 *
 * @public
 * @function
 */
const getStateVector = store => {
  const sm = new Map();
  store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1];
    sm.set(client, struct.id.clock + struct.length);
  });
  return sm
};

/**
 * @param {StructStore} store
 * @param {number} client
 * @return {number}
 *
 * @public
 * @function
 */
const getState = (store, client) => {
  const structs = store.clients.get(client);
  if (structs === undefined) {
    return 0
  }
  const lastStruct = structs[structs.length - 1];
  return lastStruct.id.clock + lastStruct.length
};

/**
 * @param {StructStore} store
 * @param {GC|Item} struct
 *
 * @private
 * @function
 */
const addStruct = (store, struct) => {
  let structs = store.clients.get(struct.id.client);
  if (structs === undefined) {
    structs = [];
    store.clients.set(struct.id.client, structs);
  } else {
    const lastStruct = structs[structs.length - 1];
    if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
      throw error__namespace.unexpectedCase()
    }
  }
  structs.push(struct);
};

/**
 * Perform a binary search on a sorted array
 * @param {Array<Item|GC>} structs
 * @param {number} clock
 * @return {number}
 *
 * @private
 * @function
 */
const findIndexSS = (structs, clock) => {
  let left = 0;
  let right = structs.length - 1;
  let mid = structs[right];
  let midclock = mid.id.clock;
  if (midclock === clock) {
    return right
  }
  // @todo does it even make sense to pivot the search?
  // If a good split misses, it might actually increase the time to find the correct item.
  // Currently, the only advantage is that search with pivoting might find the item on the first try.
  let midindex = math__namespace.floor((clock / (midclock + mid.length - 1)) * right); // pivoting the search
  while (left <= right) {
    mid = structs[midindex];
    midclock = mid.id.clock;
    if (midclock <= clock) {
      if (clock < midclock + mid.length) {
        return midindex
      }
      left = midindex + 1;
    } else {
      right = midindex - 1;
    }
    midindex = math__namespace.floor((left + right) / 2);
  }
  // Always check state before looking for a struct in StructStore
  // Therefore the case of not finding a struct is unexpected
  throw error__namespace.unexpectedCase()
};

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {GC|Item}
 *
 * @private
 * @function
 */
const find = (store, id) => {
  /**
   * @type {Array<GC|Item>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client);
  return structs[findIndexSS(structs, id.clock)]
};

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 * @private
 * @function
 */
const getItem = /** @type {function(StructStore,ID):Item} */ (find);

/**
 * @param {Transaction} transaction
 * @param {Array<Item|GC>} structs
 * @param {number} clock
 */
const findIndexCleanStart = (transaction, structs, clock) => {
  const index = findIndexSS(structs, clock);
  const struct = structs[index];
  if (struct.id.clock < clock && struct instanceof Item) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
    return index + 1
  }
  return index
};

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {Transaction} transaction
 * @param {ID} id
 * @return {Item}
 *
 * @private
 * @function
 */
const getItemCleanStart = (transaction, id) => {
  const structs = /** @type {Array<Item>} */ (transaction.doc.store.clients.get(id.client));
  return structs[findIndexCleanStart(transaction, structs, id.clock)]
};

/**
 * Expects that id is actually in store. This function throws or is an infinite loop otherwise.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 * @param {ID} id
 * @return {Item}
 *
 * @private
 * @function
 */
const getItemCleanEnd = (transaction, store, id) => {
  /**
   * @type {Array<Item>}
   */
  // @ts-ignore
  const structs = store.clients.get(id.client);
  const index = findIndexSS(structs, id.clock);
  const struct = structs[index];
  if (id.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
    structs.splice(index + 1, 0, splitItem(transaction, struct, id.clock - struct.id.clock + 1));
  }
  return struct
};

/**
 * Replace `item` with `newitem` in store
 * @param {StructStore} store
 * @param {GC|Item} struct
 * @param {GC|Item} newStruct
 *
 * @private
 * @function
 */
const replaceStruct = (store, struct, newStruct) => {
  const structs = /** @type {Array<GC|Item>} */ (store.clients.get(struct.id.client));
  structs[findIndexSS(structs, struct.id.clock)] = newStruct;
};

/**
 * Iterate over a range of structs
 *
 * @param {Transaction} transaction
 * @param {Array<Item|GC>} structs
 * @param {number} clockStart Inclusive start
 * @param {number} len
 * @param {function(GC|Item):void} f
 *
 * @function
 */
const iterateStructs = (transaction, structs, clockStart, len, f) => {
  if (len === 0) {
    return
  }
  const clockEnd = clockStart + len;
  let index = findIndexCleanStart(transaction, structs, clockStart);
  let struct;
  do {
    struct = structs[index++];
    if (clockEnd < struct.id.clock + struct.length) {
      findIndexCleanStart(transaction, structs, clockEnd);
    }
    f(struct);
  } while (index < structs.length && structs[index].id.clock < clockEnd)
};

/**
 * A transaction is created for every change on the Yjs model. It is possible
 * to bundle changes on the Yjs model in a single transaction to
 * minimize the number on messages sent and the number of observer calls.
 * If possible the user of this library should bundle as many changes as
 * possible. Here is an example to illustrate the advantages of bundling:
 *
 * @example
 * const ydoc = new Y.Doc()
 * const map = ydoc.getMap('map')
 * // Log content when change is triggered
 * map.observe(() => {
 *   console.log('change triggered')
 * })
 * // Each change on the map type triggers a log message:
 * map.set('a', 0) // => "change triggered"
 * map.set('b', 0) // => "change triggered"
 * // When put in a transaction, it will trigger the log after the transaction:
 * ydoc.transact(() => {
 *   map.set('a', 1)
 *   map.set('b', 1)
 * }) // => "change triggered"
 *
 * @public
 */
class Transaction {
  /**
   * @param {Doc} doc
   * @param {any} origin
   * @param {boolean} local
   */
  constructor (doc, origin, local) {
    /**
     * The Yjs instance.
     * @type {Doc}
     */
    this.doc = doc;
    /**
     * Describes the set of deleted items by ids
     * @type {DeleteSet}
     */
    this.deleteSet = new DeleteSet();
    /**
     * Holds the state before the transaction started.
     * @type {Map<Number,Number>}
     */
    this.beforeState = getStateVector(doc.store);
    /**
     * Holds the state after the transaction.
     * @type {Map<Number,Number>}
     */
    this.afterState = new Map();
    /**
     * All types that were directly modified (property added or child
     * inserted/deleted). New types are not included in this Set.
     * Maps from type to parentSubs (`item.parentSub = null` for YArray)
     * @type {Map<AbstractType<YEvent<any>>,Set<String|null>>}
     */
    this.changed = new Map();
    /**
     * Stores the events for the types that observe also child elements.
     * It is mainly used by `observeDeep`.
     * @type {Map<AbstractType<YEvent<any>>,Array<YEvent<any>>>}
     */
    this.changedParentTypes = new Map();
    /**
     * @type {Array<AbstractStruct>}
     */
    this._mergeStructs = [];
    /**
     * @type {any}
     */
    this.origin = origin;
    /**
     * Stores meta information on the transaction
     * @type {Map<any,any>}
     */
    this.meta = new Map();
    /**
     * Whether this change originates from this doc.
     * @type {boolean}
     */
    this.local = local;
    /**
     * @type {Set<Doc>}
     */
    this.subdocsAdded = new Set();
    /**
     * @type {Set<Doc>}
     */
    this.subdocsRemoved = new Set();
    /**
     * @type {Set<Doc>}
     */
    this.subdocsLoaded = new Set();
    /**
     * @type {boolean}
     */
    this._needFormattingCleanup = false;
  }
}

/**
 * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
 * @param {Transaction} transaction
 * @return {boolean} Whether data was written.
 */
const writeUpdateMessageFromTransaction = (encoder, transaction) => {
  if (transaction.deleteSet.clients.size === 0 && !map__namespace.any(transaction.afterState, (clock, client) => transaction.beforeState.get(client) !== clock)) {
    return false
  }
  sortAndMergeDeleteSet(transaction.deleteSet);
  writeStructsFromTransaction(encoder, transaction);
  writeDeleteSet(encoder, transaction.deleteSet);
  return true
};

/**
 * If `type.parent` was added in current transaction, `type` technically
 * did not change, it was just added and we should not fire events for `type`.
 *
 * @param {Transaction} transaction
 * @param {AbstractType<YEvent<any>>} type
 * @param {string|null} parentSub
 */
const addChangedTypeToTransaction = (transaction, type, parentSub) => {
  const item = type._item;
  if (item === null || (item.id.clock < (transaction.beforeState.get(item.id.client) || 0) && !item.deleted)) {
    map__namespace.setIfUndefined(transaction.changed, type, set__namespace.create).add(parentSub);
  }
};

/**
 * @param {Array<AbstractStruct>} structs
 * @param {number} pos
 * @return {number} # of merged structs
 */
const tryToMergeWithLefts = (structs, pos) => {
  let right = structs[pos];
  let left = structs[pos - 1];
  let i = pos;
  for (; i > 0; right = left, left = structs[--i - 1]) {
    if (left.deleted === right.deleted && left.constructor === right.constructor) {
      if (left.mergeWith(right)) {
        if (right instanceof Item && right.parentSub !== null && /** @type {AbstractType<any>} */ (right.parent)._map.get(right.parentSub) === right) {
          /** @type {AbstractType<any>} */ (right.parent)._map.set(right.parentSub, /** @type {Item} */ (left));
        }
        continue
      }
    }
    break
  }
  const merged = pos - i;
  if (merged) {
    // remove all merged structs from the array
    structs.splice(pos + 1 - merged, merged);
  }
  return merged
};

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 * @param {function(Item):boolean} gcFilter
 */
const tryGcDeleteSet = (ds, store, gcFilter) => {
  for (const [client, deleteItems] of ds.clients.entries()) {
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client));
    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di];
      const endDeleteItemClock = deleteItem.clock + deleteItem.len;
      for (
        let si = findIndexSS(structs, deleteItem.clock), struct = structs[si];
        si < structs.length && struct.id.clock < endDeleteItemClock;
        struct = structs[++si]
      ) {
        const struct = structs[si];
        if (deleteItem.clock + deleteItem.len <= struct.id.clock) {
          break
        }
        if (struct instanceof Item && struct.deleted && !struct.keep && gcFilter(struct)) {
          struct.gc(store, false);
        }
      }
    }
  }
};

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 */
const tryMergeDeleteSet = (ds, store) => {
  // try to merge deleted / gc'd items
  // merge from right to left for better efficiency and so we don't miss any merge targets
  ds.clients.forEach((deleteItems, client) => {
    const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client));
    for (let di = deleteItems.length - 1; di >= 0; di--) {
      const deleteItem = deleteItems[di];
      // start with merging the item next to the last deleted item
      const mostRightIndexToCheck = math__namespace.min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1));
      for (
        let si = mostRightIndexToCheck, struct = structs[si];
        si > 0 && struct.id.clock >= deleteItem.clock;
        struct = structs[si]
      ) {
        si -= 1 + tryToMergeWithLefts(structs, si);
      }
    }
  });
};

/**
 * @param {DeleteSet} ds
 * @param {StructStore} store
 * @param {function(Item):boolean} gcFilter
 */
const tryGc$1 = (ds, store, gcFilter) => {
  tryGcDeleteSet(ds, store, gcFilter);
  tryMergeDeleteSet(ds, store);
};

/**
 * @param {Array<Transaction>} transactionCleanups
 * @param {number} i
 */
const cleanupTransactions = (transactionCleanups, i) => {
  while (i < transactionCleanups.length) {
    const transaction = transactionCleanups[i];
    const doc = transaction.doc;
    const store = doc.store;
    const ds = transaction.deleteSet;
    const mergeStructs = transaction._mergeStructs;
    try {
      sortAndMergeDeleteSet(ds);
      transaction.afterState = getStateVector(transaction.doc.store);
      doc.emit('beforeObserverCalls', [transaction, doc]);
      /**
       * An array of event callbacks.
       *
       * Each callback is called even if the other ones throw errors.
       *
       * @type {Array<function():void>}
       */
      const fs = [];
      // observe events on changed types
      transaction.changed.forEach((subs, itemtype) =>
        fs.push(() => {
          if (itemtype._item === null || !itemtype._item.deleted) {
            itemtype._callObserver(transaction, subs);
          }
        })
      );
      fs.push(() => {
        // deep observe events
        transaction.changedParentTypes.forEach((events, type) => {
          // We need to think about the possibility that the user transforms the
          // Y.Doc in the event.
          if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
            events = events
              .filter(event =>
                event.target._item === null || !event.target._item.deleted
              );
            events
              .forEach(event => {
                event.currentTarget = type;
                // path is relative to the current target
                event._path = null;
              });
            // sort events by path length so that top-level events are fired first.
            events
              .sort((event1, event2) => event1.path.length - event2.path.length);
            // We don't need to check for events.length
            // because we know it has at least one element
            callEventHandlerListeners(type._dEH, events, transaction);
          }
        });
      });
      fs.push(() => doc.emit('afterTransaction', [transaction, doc]));
      f.callAll(fs, []);
      if (transaction._needFormattingCleanup) {
        cleanupYTextAfterTransaction(transaction);
      }
    } finally {
      // Replace deleted items with ItemDeleted / GC.
      // This is where content is actually remove from the Yjs Doc.
      if (doc.gc) {
        tryGcDeleteSet(ds, store, doc.gcFilter);
      }
      tryMergeDeleteSet(ds, store);

      // on all affected store.clients props, try to merge
      transaction.afterState.forEach((clock, client) => {
        const beforeClock = transaction.beforeState.get(client) || 0;
        if (beforeClock !== clock) {
          const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client));
          // we iterate from right to left so we can safely remove entries
          const firstChangePos = math__namespace.max(findIndexSS(structs, beforeClock), 1);
          for (let i = structs.length - 1; i >= firstChangePos;) {
            i -= 1 + tryToMergeWithLefts(structs, i);
          }
        }
      });
      // try to merge mergeStructs
      // @todo: it makes more sense to transform mergeStructs to a DS, sort it, and merge from right to left
      //        but at the moment DS does not handle duplicates
      for (let i = mergeStructs.length - 1; i >= 0; i--) {
        const { client, clock } = mergeStructs[i].id;
        const structs = /** @type {Array<GC|Item>} */ (store.clients.get(client));
        const replacedStructPos = findIndexSS(structs, clock);
        if (replacedStructPos + 1 < structs.length) {
          if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
            continue // no need to perform next check, both are already merged
          }
        }
        if (replacedStructPos > 0) {
          tryToMergeWithLefts(structs, replacedStructPos);
        }
      }
      if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
        logging__namespace.print(logging__namespace.ORANGE, logging__namespace.BOLD, '[yjs] ', logging__namespace.UNBOLD, logging__namespace.RED, 'Changed the client-id because another client seems to be using it.');
        doc.clientID = generateNewClientId();
      }
      // @todo Merge all the transactions into one and provide send the data as a single update message
      doc.emit('afterTransactionCleanup', [transaction, doc]);
      if (doc._observers.has('update')) {
        const encoder = new UpdateEncoderV1();
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction);
        if (hasContent) {
          doc.emit('update', [encoder.toUint8Array(), transaction.origin, doc, transaction]);
        }
      }
      if (doc._observers.has('updateV2')) {
        const encoder = new UpdateEncoderV2();
        const hasContent = writeUpdateMessageFromTransaction(encoder, transaction);
        if (hasContent) {
          doc.emit('updateV2', [encoder.toUint8Array(), transaction.origin, doc, transaction]);
        }
      }
      const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction;
      if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
        subdocsAdded.forEach(subdoc => {
          subdoc.clientID = doc.clientID;
          if (subdoc.collectionid == null) {
            subdoc.collectionid = doc.collectionid;
          }
          doc.subdocs.add(subdoc);
        });
        subdocsRemoved.forEach(subdoc => doc.subdocs.delete(subdoc));
        doc.emit('subdocs', [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction]);
        subdocsRemoved.forEach(subdoc => subdoc.destroy());
      }

      if (transactionCleanups.length <= ++i) {
        doc._transactionCleanups = [];
        doc.emit('afterAllTransactions', [doc, transactionCleanups]);
      }// else {
      //  cleanupTransactions(transactionCleanups, i + 1)
      //}
    }
  }
};

/**
 * Implements the functionality of `y.transact(()=>{..})`
 *
 * @template T
 * @param {Doc} doc
 * @param {function(Transaction):T} f
 * @param {any} [origin=true]
 * @return {T}
 *
 * @function
 */
const transact = (doc, f, origin = null, local = true) => {
  const transactionCleanups = doc._transactionCleanups;
  let initialCall = false;
  /**
   * @type {any}
   */
  let result = null;
  if (doc._transaction === null) {
    initialCall = true;
    doc._transaction = new Transaction(doc, origin, local);
    transactionCleanups.push(doc._transaction);
    if (transactionCleanups.length === 1) {
      doc.emit('beforeAllTransactions', [doc]);
    }
    doc.emit('beforeTransaction', [doc._transaction, doc]);
  }
  try {
    result = f(doc._transaction);
  } finally {
    if (initialCall) {
      const finishCleanup = doc._transaction === transactionCleanups[0];
      doc._transaction = null;
      if (finishCleanup) {
        // The first transaction ended, now process observer calls.
        // Observer call may create new transactions for which we need to call the observers and do cleanup.
        // We don't want to nest these calls, so we execute these calls one after
        // another.
        // Also we need to ensure that all cleanups are called, even if the
        // observes throw errors.
        // This file is full of hacky try {} finally {} blocks to ensure that an
        // event can throw errors and also that the cleanup is called.
        cleanupTransactions(transactionCleanups, 0);
      }
    }
  }
  return result
};

class StackItem {
  /**
   * @param {DeleteSet} deletions
   * @param {DeleteSet} insertions
   */
  constructor (deletions, insertions) {
    this.insertions = insertions;
    this.deletions = deletions;
    /**
     * Use this to save and restore metadata like selection range
     */
    this.meta = new Map();
  }
}
/**
 * @param {Transaction} tr
 * @param {UndoManager} um
 * @param {StackItem} stackItem
 */
const clearUndoManagerStackItem = (tr, um, stackItem) => {
  iterateDeletedStructs(tr, stackItem.deletions, item => {
    if (item instanceof Item && um.scope.some(type => isParentOf(type, item))) {
      keepItem(item, false);
    }
  });
};

/**
 * @param {UndoManager} undoManager
 * @param {Array<StackItem>} stack
 * @param {'undo'|'redo'} eventType
 * @return {StackItem?}
 */
const popStackItem = (undoManager, stack, eventType) => {
  /**
   * Keep a reference to the transaction so we can fire the event with the changedParentTypes
   * @type {any}
   */
  let _tr = null;
  const doc = undoManager.doc;
  const scope = undoManager.scope;
  transact(doc, transaction => {
    while (stack.length > 0 && undoManager.currStackItem === null) {
      const store = doc.store;
      const stackItem = /** @type {StackItem} */ (stack.pop());
      /**
       * @type {Set<Item>}
       */
      const itemsToRedo = new Set();
      /**
       * @type {Array<Item>}
       */
      const itemsToDelete = [];
      let performedChange = false;
      iterateDeletedStructs(transaction, stackItem.insertions, struct => {
        if (struct instanceof Item) {
          if (struct.redone !== null) {
            let { item, diff } = followRedone(store, struct.id);
            if (diff > 0) {
              item = getItemCleanStart(transaction, createID(item.id.client, item.id.clock + diff));
            }
            struct = item;
          }
          if (!struct.deleted && scope.some(type => isParentOf(type, /** @type {Item} */ (struct)))) {
            itemsToDelete.push(struct);
          }
        }
      });
      iterateDeletedStructs(transaction, stackItem.deletions, struct => {
        if (
          struct instanceof Item &&
          scope.some(type => isParentOf(type, struct)) &&
          // Never redo structs in stackItem.insertions because they were created and deleted in the same capture interval.
          !isDeleted(stackItem.insertions, struct.id)
        ) {
          itemsToRedo.add(struct);
        }
      });
      itemsToRedo.forEach(struct => {
        performedChange = redoItem(transaction, struct, itemsToRedo, stackItem.insertions, undoManager.ignoreRemoteMapChanges, undoManager) !== null || performedChange;
      });
      // We want to delete in reverse order so that children are deleted before
      // parents, so we have more information available when items are filtered.
      for (let i = itemsToDelete.length - 1; i >= 0; i--) {
        const item = itemsToDelete[i];
        if (undoManager.deleteFilter(item)) {
          item.delete(transaction);
          performedChange = true;
        }
      }
      undoManager.currStackItem = performedChange ? stackItem : null;
    }
    transaction.changed.forEach((subProps, type) => {
      // destroy search marker if necessary
      if (subProps.has(null) && type._searchMarker) {
        type._searchMarker.length = 0;
      }
    });
    _tr = transaction;
  }, undoManager);
  const res = undoManager.currStackItem;
  if (res != null) {
    const changedParentTypes = _tr.changedParentTypes;
    undoManager.emit('stack-item-popped', [{ stackItem: res, type: eventType, changedParentTypes, origin: undoManager }, undoManager]);
    undoManager.currStackItem = null;
  }
  return res
};

/**
 * @typedef {Object} UndoManagerOptions
 * @property {number} [UndoManagerOptions.captureTimeout=500]
 * @property {function(Transaction):boolean} [UndoManagerOptions.captureTransaction] Do not capture changes of a Transaction if result false.
 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
 * it is necessary to filter what an Undo/Redo operation can delete. If this
 * filter returns false, the type/item won't be deleted even it is in the
 * undo/redo scope.
 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
 * @property {boolean} [ignoreRemoteMapChanges] Experimental. By default, the UndoManager will never overwrite remote changes. Enable this property to enable overwriting remote changes on key-value changes (Y.Map, properties on Y.Xml, etc..).
 * @property {Doc} [doc] The document that this UndoManager operates on. Only needed if typeScope is empty.
 */

/**
 * @typedef {Object} StackItemEvent
 * @property {StackItem} StackItemEvent.stackItem
 * @property {any} StackItemEvent.origin
 * @property {'undo'|'redo'} StackItemEvent.type
 * @property {Map<AbstractType<YEvent<any>>,Array<YEvent<any>>>} StackItemEvent.changedParentTypes
 */

/**
 * Fires 'stack-item-added' event when a stack item was added to either the undo- or
 * the redo-stack. You may store additional stack information via the
 * metadata property on `event.stackItem.meta` (it is a `Map` of metadata properties).
 * Fires 'stack-item-popped' event when a stack item was popped from either the
 * undo- or the redo-stack. You may restore the saved stack information from `event.stackItem.meta`.
 *
 * @extends {ObservableV2<{'stack-item-added':function(StackItemEvent, UndoManager):void, 'stack-item-popped': function(StackItemEvent, UndoManager):void, 'stack-cleared': function({ undoStackCleared: boolean, redoStackCleared: boolean }):void, 'stack-item-updated': function(StackItemEvent, UndoManager):void }>}
 */
class UndoManager extends observable.ObservableV2 {
  /**
   * @param {AbstractType<any>|Array<AbstractType<any>>} typeScope Accepts either a single type, or an array of types
   * @param {UndoManagerOptions} options
   */
  constructor (typeScope, {
    captureTimeout = 500,
    captureTransaction = _tr => true,
    deleteFilter = () => true,
    trackedOrigins = new Set([null]),
    ignoreRemoteMapChanges = false,
    doc = /** @type {Doc} */ (array__namespace.isArray(typeScope) ? typeScope[0].doc : typeScope.doc)
  } = {}) {
    super();
    /**
     * @type {Array<AbstractType<any>>}
     */
    this.scope = [];
    this.doc = doc;
    this.addToScope(typeScope);
    this.deleteFilter = deleteFilter;
    trackedOrigins.add(this);
    this.trackedOrigins = trackedOrigins;
    this.captureTransaction = captureTransaction;
    /**
     * @type {Array<StackItem>}
     */
    this.undoStack = [];
    /**
     * @type {Array<StackItem>}
     */
    this.redoStack = [];
    /**
     * Whether the client is currently undoing (calling UndoManager.undo)
     *
     * @type {boolean}
     */
    this.undoing = false;
    this.redoing = false;
    /**
     * The currently popped stack item if UndoManager.undoing or UndoManager.redoing
     *
     * @type {StackItem|null}
     */
    this.currStackItem = null;
    this.lastChange = 0;
    this.ignoreRemoteMapChanges = ignoreRemoteMapChanges;
    this.captureTimeout = captureTimeout;
    /**
     * @param {Transaction} transaction
     */
    this.afterTransactionHandler = transaction => {
      // Only track certain transactions
      if (
        !this.captureTransaction(transaction) ||
        !this.scope.some(type => transaction.changedParentTypes.has(type)) ||
        (!this.trackedOrigins.has(transaction.origin) && (!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor)))
      ) {
        return
      }
      const undoing = this.undoing;
      const redoing = this.redoing;
      const stack = undoing ? this.redoStack : this.undoStack;
      if (undoing) {
        this.stopCapturing(); // next undo should not be appended to last stack item
      } else if (!redoing) {
        // neither undoing nor redoing: delete redoStack
        this.clear(false, true);
      }
      const insertions = new DeleteSet();
      transaction.afterState.forEach((endClock, client) => {
        const startClock = transaction.beforeState.get(client) || 0;
        const len = endClock - startClock;
        if (len > 0) {
          addToDeleteSet(insertions, client, startClock, len);
        }
      });
      const now = time__namespace.getUnixTime();
      let didAdd = false;
      if (this.lastChange > 0 && now - this.lastChange < this.captureTimeout && stack.length > 0 && !undoing && !redoing) {
        // append change to last stack op
        const lastOp = stack[stack.length - 1];
        lastOp.deletions = mergeDeleteSets([lastOp.deletions, transaction.deleteSet]);
        lastOp.insertions = mergeDeleteSets([lastOp.insertions, insertions]);
      } else {
        // create a new stack op
        stack.push(new StackItem(transaction.deleteSet, insertions));
        didAdd = true;
      }
      if (!undoing && !redoing) {
        this.lastChange = now;
      }
      // make sure that deleted structs are not gc'd
      iterateDeletedStructs(transaction, transaction.deleteSet, /** @param {Item|GC} item */ item => {
        if (item instanceof Item && this.scope.some(type => isParentOf(type, item))) {
          keepItem(item, true);
        }
      });
      /**
       * @type {[StackItemEvent, UndoManager]}
       */
      const changeEvent = [{ stackItem: stack[stack.length - 1], origin: transaction.origin, type: undoing ? 'redo' : 'undo', changedParentTypes: transaction.changedParentTypes }, this];
      if (didAdd) {
        this.emit('stack-item-added', changeEvent);
      } else {
        this.emit('stack-item-updated', changeEvent);
      }
    };
    this.doc.on('afterTransaction', this.afterTransactionHandler);
    this.doc.on('destroy', () => {
      this.destroy();
    });
  }

  /**
   * @param {Array<AbstractType<any>> | AbstractType<any>} ytypes
   */
  addToScope (ytypes) {
    ytypes = array__namespace.isArray(ytypes) ? ytypes : [ytypes];
    ytypes.forEach(ytype => {
      if (this.scope.every(yt => yt !== ytype)) {
        if (ytype.doc !== this.doc) logging__namespace.warn('[yjs#509] Not same Y.Doc'); // use MultiDocUndoManager instead. also see https://github.com/yjs/yjs/issues/509
        this.scope.push(ytype);
      }
    });
  }

  /**
   * @param {any} origin
   */
  addTrackedOrigin (origin) {
    this.trackedOrigins.add(origin);
  }

  /**
   * @param {any} origin
   */
  removeTrackedOrigin (origin) {
    this.trackedOrigins.delete(origin);
  }

  clear (clearUndoStack = true, clearRedoStack = true) {
    if ((clearUndoStack && this.canUndo()) || (clearRedoStack && this.canRedo())) {
      this.doc.transact(tr => {
        if (clearUndoStack) {
          this.undoStack.forEach(item => clearUndoManagerStackItem(tr, this, item));
          this.undoStack = [];
        }
        if (clearRedoStack) {
          this.redoStack.forEach(item => clearUndoManagerStackItem(tr, this, item));
          this.redoStack = [];
        }
        this.emit('stack-cleared', [{ undoStackCleared: clearUndoStack, redoStackCleared: clearRedoStack }]);
      });
    }
  }

  /**
   * UndoManager merges Undo-StackItem if they are created within time-gap
   * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
   * StackItem won't be merged.
   *
   *
   * @example
   *     // without stopCapturing
   *     ytext.insert(0, 'a')
   *     ytext.insert(1, 'b')
   *     um.undo()
   *     ytext.toString() // => '' (note that 'ab' was removed)
   *     // with stopCapturing
   *     ytext.insert(0, 'a')
   *     um.stopCapturing()
   *     ytext.insert(0, 'b')
   *     um.undo()
   *     ytext.toString() // => 'a' (note that only 'b' was removed)
   *
   */
  stopCapturing () {
    this.lastChange = 0;
  }

  /**
   * Undo last changes on type.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  undo () {
    this.undoing = true;
    let res;
    try {
      res = popStackItem(this, this.undoStack, 'undo');
    } finally {
      this.undoing = false;
    }
    return res
  }

  /**
   * Redo last undo operation.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  redo () {
    this.redoing = true;
    let res;
    try {
      res = popStackItem(this, this.redoStack, 'redo');
    } finally {
      this.redoing = false;
    }
    return res
  }

  /**
   * Are undo steps available?
   *
   * @return {boolean} `true` if undo is possible
   */
  canUndo () {
    return this.undoStack.length > 0
  }

  /**
   * Are redo steps available?
   *
   * @return {boolean} `true` if redo is possible
   */
  canRedo () {
    return this.redoStack.length > 0
  }

  destroy () {
    this.trackedOrigins.delete(this);
    this.doc.off('afterTransaction', this.afterTransactionHandler);
    super.destroy();
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 */
function * lazyStructReaderGenerator (decoder) {
  const numOfStateUpdates = decoding__namespace.readVarUint(decoder.restDecoder);
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding__namespace.readVarUint(decoder.restDecoder);
    const client = decoder.readClient();
    let clock = decoding__namespace.readVarUint(decoder.restDecoder);
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo();
      // @todo use switch instead of ifs
      if (info === 10) {
        const len = decoding__namespace.readVarUint(decoder.restDecoder);
        yield new Skip(createID(client, clock), len);
        clock += len;
      } else if ((binary__namespace.BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (binary__namespace.BIT7 | binary__namespace.BIT8)) === 0;
        // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
        // and we read the next string as parentYKey.
        // It indicates how we store/retrieve parent from `y.share`
        // @type {string|null}
        const struct = new Item(
          createID(client, clock),
          null, // left
          (info & binary__namespace.BIT8) === binary__namespace.BIT8 ? decoder.readLeftID() : null, // origin
          null, // right
          (info & binary__namespace.BIT7) === binary__namespace.BIT7 ? decoder.readRightID() : null, // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? (decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID()) : null, // parent
          cantCopyParentInfo && (info & binary__namespace.BIT6) === binary__namespace.BIT6 ? decoder.readString() : null, // parentSub
          readItemContent(decoder, info) // item content
        );
        yield struct;
        clock += struct.length;
      } else {
        const len = decoder.readLen();
        yield new GC(createID(client, clock), len);
        clock += len;
      }
    }
  }
}

class LazyStructReader {
  /**
   * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
   * @param {boolean} filterSkips
   */
  constructor (decoder, filterSkips) {
    this.gen = lazyStructReaderGenerator(decoder);
    /**
     * @type {null | Item | Skip | GC}
     */
    this.curr = null;
    this.done = false;
    this.filterSkips = filterSkips;
    this.next();
  }

  /**
   * @return {Item | GC | Skip |null}
   */
  next () {
    // ignore "Skip" structs
    do {
      this.curr = this.gen.next().value || null;
    } while (this.filterSkips && this.curr !== null && this.curr.constructor === Skip)
    return this.curr
  }
}

/**
 * @param {Uint8Array} update
 *
 */
const logUpdate = update => logUpdateV2(update, UpdateDecoderV1);

/**
 * @param {Uint8Array} update
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} [YDecoder]
 *
 */
const logUpdateV2 = (update, YDecoder = UpdateDecoderV2) => {
  const structs = [];
  const updateDecoder = new YDecoder(decoding__namespace.createDecoder(update));
  const lazyDecoder = new LazyStructReader(updateDecoder, false);
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    structs.push(curr);
  }
  logging__namespace.print('Structs: ', structs);
  const ds = readDeleteSet(updateDecoder);
  logging__namespace.print('DeleteSet: ', ds);
};

/**
 * @param {Uint8Array} update
 *
 */
const decodeUpdate = (update) => decodeUpdateV2(update, UpdateDecoderV1);

/**
 * @param {Uint8Array} update
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} [YDecoder]
 *
 */
const decodeUpdateV2 = (update, YDecoder = UpdateDecoderV2) => {
  const structs = [];
  const updateDecoder = new YDecoder(decoding__namespace.createDecoder(update));
  const lazyDecoder = new LazyStructReader(updateDecoder, false);
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    structs.push(curr);
  }
  return {
    structs,
    ds: readDeleteSet(updateDecoder)
  }
};

class LazyStructWriter {
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  constructor (encoder) {
    this.currClient = 0;
    this.startClock = 0;
    this.written = 0;
    this.encoder = encoder;
    /**
     * We want to write operations lazily, but also we need to know beforehand how many operations we want to write for each client.
     *
     * This kind of meta-information (#clients, #structs-per-client-written) is written to the restEncoder.
     *
     * We fragment the restEncoder and store a slice of it per-client until we know how many clients there are.
     * When we flush (toUint8Array) we write the restEncoder using the fragments and the meta-information.
     *
     * @type {Array<{ written: number, restEncoder: Uint8Array }>}
     */
    this.clientStructs = [];
  }
}

/**
 * @param {Array<Uint8Array>} updates
 * @return {Uint8Array}
 */
const mergeUpdates = updates => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1);

/**
 * @param {Uint8Array} update
 * @param {typeof DSEncoderV1 | typeof DSEncoderV2} YEncoder
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} YDecoder
 * @return {Uint8Array}
 */
const encodeStateVectorFromUpdateV2 = (update, YEncoder = DSEncoderV2, YDecoder = UpdateDecoderV2) => {
  const encoder = new YEncoder();
  const updateDecoder = new LazyStructReader(new YDecoder(decoding__namespace.createDecoder(update)), false);
  let curr = updateDecoder.curr;
  if (curr !== null) {
    let size = 0;
    let currClient = curr.id.client;
    let stopCounting = curr.id.clock !== 0; // must start at 0
    let currClock = stopCounting ? 0 : curr.id.clock + curr.length;
    for (; curr !== null; curr = updateDecoder.next()) {
      if (currClient !== curr.id.client) {
        if (currClock !== 0) {
          size++;
          // We found a new client
          // write what we have to the encoder
          encoding__namespace.writeVarUint(encoder.restEncoder, currClient);
          encoding__namespace.writeVarUint(encoder.restEncoder, currClock);
        }
        currClient = curr.id.client;
        currClock = 0;
        stopCounting = curr.id.clock !== 0;
      }
      // we ignore skips
      if (curr.constructor === Skip) {
        stopCounting = true;
      }
      if (!stopCounting) {
        currClock = curr.id.clock + curr.length;
      }
    }
    // write what we have
    if (currClock !== 0) {
      size++;
      encoding__namespace.writeVarUint(encoder.restEncoder, currClient);
      encoding__namespace.writeVarUint(encoder.restEncoder, currClock);
    }
    // prepend the size of the state vector
    const enc = encoding__namespace.createEncoder();
    encoding__namespace.writeVarUint(enc, size);
    encoding__namespace.writeBinaryEncoder(enc, encoder.restEncoder);
    encoder.restEncoder = enc;
    return encoder.toUint8Array()
  } else {
    encoding__namespace.writeVarUint(encoder.restEncoder, 0);
    return encoder.toUint8Array()
  }
};

/**
 * @param {Uint8Array} update
 * @return {Uint8Array}
 */
const encodeStateVectorFromUpdate = update => encodeStateVectorFromUpdateV2(update, DSEncoderV1, UpdateDecoderV1);

/**
 * @param {Uint8Array} update
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} YDecoder
 * @return {{ from: Map<number,number>, to: Map<number,number> }}
 */
const parseUpdateMetaV2 = (update, YDecoder = UpdateDecoderV2) => {
  /**
   * @type {Map<number, number>}
   */
  const from = new Map();
  /**
   * @type {Map<number, number>}
   */
  const to = new Map();
  const updateDecoder = new LazyStructReader(new YDecoder(decoding__namespace.createDecoder(update)), false);
  let curr = updateDecoder.curr;
  if (curr !== null) {
    let currClient = curr.id.client;
    let currClock = curr.id.clock;
    // write the beginning to `from`
    from.set(currClient, currClock);
    for (; curr !== null; curr = updateDecoder.next()) {
      if (currClient !== curr.id.client) {
        // We found a new client
        // write the end to `to`
        to.set(currClient, currClock);
        // write the beginning to `from`
        from.set(curr.id.client, curr.id.clock);
        // update currClient
        currClient = curr.id.client;
      }
      currClock = curr.id.clock + curr.length;
    }
    // write the end to `to`
    to.set(currClient, currClock);
  }
  return { from, to }
};

/**
 * @param {Uint8Array} update
 * @return {{ from: Map<number,number>, to: Map<number,number> }}
 */
const parseUpdateMeta = update => parseUpdateMetaV2(update, UpdateDecoderV1);

/**
 * This method is intended to slice any kind of struct and retrieve the right part.
 * It does not handle side-effects, so it should only be used by the lazy-encoder.
 *
 * @param {Item | GC | Skip} left
 * @param {number} diff
 * @return {Item | GC}
 */
const sliceStruct = (left, diff) => {
  if (left.constructor === GC) {
    const { client, clock } = left.id;
    return new GC(createID(client, clock + diff), left.length - diff)
  } else if (left.constructor === Skip) {
    const { client, clock } = left.id;
    return new Skip(createID(client, clock + diff), left.length - diff)
  } else {
    const leftItem = /** @type {Item} */ (left);
    const { client, clock } = leftItem.id;
    return new Item(
      createID(client, clock + diff),
      null,
      createID(client, clock + diff - 1),
      null,
      leftItem.rightOrigin,
      leftItem.parent,
      leftItem.parentSub,
      leftItem.content.splice(diff)
    )
  }
};

/**
 *
 * This function works similarly to `readUpdateV2`.
 *
 * @param {Array<Uint8Array>} updates
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 * @return {Uint8Array}
 */
const mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  if (updates.length === 1) {
    return updates[0]
  }
  const updateDecoders = updates.map(update => new YDecoder(decoding__namespace.createDecoder(update)));
  let lazyStructDecoders = updateDecoders.map(decoder => new LazyStructReader(decoder, true));

  /**
   * @todo we don't need offset because we always slice before
   * @type {null | { struct: Item | GC | Skip, offset: number }}
   */
  let currWrite = null;

  const updateEncoder = new YEncoder();
  // write structs lazily
  const lazyStructEncoder = new LazyStructWriter(updateEncoder);

  // Note: We need to ensure that all lazyStructDecoders are fully consumed
  // Note: Should merge document updates whenever possible - even from different updates
  // Note: Should handle that some operations cannot be applied yet ()

  while (true) {
    // Write higher clients first ⇒ sort by clientID & clock and remove decoders without content
    lazyStructDecoders = lazyStructDecoders.filter(dec => dec.curr !== null);
    lazyStructDecoders.sort(
      /** @type {function(any,any):number} */ (dec1, dec2) => {
        if (dec1.curr.id.client === dec2.curr.id.client) {
          const clockDiff = dec1.curr.id.clock - dec2.curr.id.clock;
          if (clockDiff === 0) {
            // @todo remove references to skip since the structDecoders must filter Skips.
            return dec1.curr.constructor === dec2.curr.constructor
              ? 0
              : dec1.curr.constructor === Skip ? 1 : -1 // we are filtering skips anyway.
          } else {
            return clockDiff
          }
        } else {
          return dec2.curr.id.client - dec1.curr.id.client
        }
      }
    );
    if (lazyStructDecoders.length === 0) {
      break
    }
    const currDecoder = lazyStructDecoders[0];
    // write from currDecoder until the next operation is from another client or if filler-struct
    // then we need to reorder the decoders and find the next operation to write
    const firstClient = /** @type {Item | GC} */ (currDecoder.curr).id.client;

    if (currWrite !== null) {
      let curr = /** @type {Item | GC | null} */ (currDecoder.curr);
      let iterated = false;

      // iterate until we find something that we haven't written already
      // remember: first the high client-ids are written
      while (curr !== null && curr.id.clock + curr.length <= currWrite.struct.id.clock + currWrite.struct.length && curr.id.client >= currWrite.struct.id.client) {
        curr = currDecoder.next();
        iterated = true;
      }
      if (
        curr === null || // current decoder is empty
        curr.id.client !== firstClient || // check whether there is another decoder that has has updates from `firstClient`
        (iterated && curr.id.clock > currWrite.struct.id.clock + currWrite.struct.length) // the above while loop was used and we are potentially missing updates
      ) {
        continue
      }

      if (firstClient !== currWrite.struct.id.client) {
        writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
        currWrite = { struct: curr, offset: 0 };
        currDecoder.next();
      } else {
        if (currWrite.struct.id.clock + currWrite.struct.length < curr.id.clock) {
          // @todo write currStruct & set currStruct = Skip(clock = currStruct.id.clock + currStruct.length, length = curr.id.clock - self.clock)
          if (currWrite.struct.constructor === Skip) {
            // extend existing skip
            currWrite.struct.length = curr.id.clock + curr.length - currWrite.struct.id.clock;
          } else {
            writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
            const diff = curr.id.clock - currWrite.struct.id.clock - currWrite.struct.length;
            /**
             * @type {Skip}
             */
            const struct = new Skip(createID(firstClient, currWrite.struct.id.clock + currWrite.struct.length), diff);
            currWrite = { struct, offset: 0 };
          }
        } else { // if (currWrite.struct.id.clock + currWrite.struct.length >= curr.id.clock) {
          const diff = currWrite.struct.id.clock + currWrite.struct.length - curr.id.clock;
          if (diff > 0) {
            if (currWrite.struct.constructor === Skip) {
              // prefer to slice Skip because the other struct might contain more information
              currWrite.struct.length -= diff;
            } else {
              curr = sliceStruct(curr, diff);
            }
          }
          if (!currWrite.struct.mergeWith(/** @type {any} */ (curr))) {
            writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
            currWrite = { struct: curr, offset: 0 };
            currDecoder.next();
          }
        }
      }
    } else {
      currWrite = { struct: /** @type {Item | GC} */ (currDecoder.curr), offset: 0 };
      currDecoder.next();
    }
    for (
      let next = currDecoder.curr;
      next !== null && next.id.client === firstClient && next.id.clock === currWrite.struct.id.clock + currWrite.struct.length && next.constructor !== Skip;
      next = currDecoder.next()
    ) {
      writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
      currWrite = { struct: next, offset: 0 };
    }
  }
  if (currWrite !== null) {
    writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
    currWrite = null;
  }
  finishLazyStructWriting(lazyStructEncoder);

  const dss = updateDecoders.map(decoder => readDeleteSet(decoder));
  const ds = mergeDeleteSets(dss);
  writeDeleteSet(updateEncoder, ds);
  return updateEncoder.toUint8Array()
};

/**
 * @param {Uint8Array} update
 * @param {Uint8Array} sv
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 */
const diffUpdateV2 = (update, sv, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  const state = decodeStateVector(sv);
  const encoder = new YEncoder();
  const lazyStructWriter = new LazyStructWriter(encoder);
  const decoder = new YDecoder(decoding__namespace.createDecoder(update));
  const reader = new LazyStructReader(decoder, false);
  while (reader.curr) {
    const curr = reader.curr;
    const currClient = curr.id.client;
    const svClock = state.get(currClient) || 0;
    if (reader.curr.constructor === Skip) {
      // the first written struct shouldn't be a skip
      reader.next();
      continue
    }
    if (curr.id.clock + curr.length > svClock) {
      writeStructToLazyStructWriter(lazyStructWriter, curr, math__namespace.max(svClock - curr.id.clock, 0));
      reader.next();
      while (reader.curr && reader.curr.id.client === currClient) {
        writeStructToLazyStructWriter(lazyStructWriter, reader.curr, 0);
        reader.next();
      }
    } else {
      // read until something new comes up
      while (reader.curr && reader.curr.id.client === currClient && reader.curr.id.clock + reader.curr.length <= svClock) {
        reader.next();
      }
    }
  }
  finishLazyStructWriting(lazyStructWriter);
  // write ds
  const ds = readDeleteSet(decoder);
  writeDeleteSet(encoder, ds);
  return encoder.toUint8Array()
};

/**
 * @param {Uint8Array} update
 * @param {Uint8Array} sv
 */
const diffUpdate = (update, sv) => diffUpdateV2(update, sv, UpdateDecoderV1, UpdateEncoderV1);

/**
 * @param {LazyStructWriter} lazyWriter
 */
const flushLazyStructWriter = lazyWriter => {
  if (lazyWriter.written > 0) {
    lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: encoding__namespace.toUint8Array(lazyWriter.encoder.restEncoder) });
    lazyWriter.encoder.restEncoder = encoding__namespace.createEncoder();
    lazyWriter.written = 0;
  }
};

/**
 * @param {LazyStructWriter} lazyWriter
 * @param {Item | GC} struct
 * @param {number} offset
 */
const writeStructToLazyStructWriter = (lazyWriter, struct, offset) => {
  // flush curr if we start another client
  if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
    flushLazyStructWriter(lazyWriter);
  }
  if (lazyWriter.written === 0) {
    lazyWriter.currClient = struct.id.client;
    // write next client
    lazyWriter.encoder.writeClient(struct.id.client);
    // write startClock
    encoding__namespace.writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock + offset);
  }
  struct.write(lazyWriter.encoder, offset);
  lazyWriter.written++;
};
/**
 * Call this function when we collected all parts and want to
 * put all the parts together. After calling this method,
 * you can continue using the UpdateEncoder.
 *
 * @param {LazyStructWriter} lazyWriter
 */
const finishLazyStructWriting = (lazyWriter) => {
  flushLazyStructWriter(lazyWriter);

  // this is a fresh encoder because we called flushCurr
  const restEncoder = lazyWriter.encoder.restEncoder;

  /**
   * Now we put all the fragments together.
   * This works similarly to `writeClientsStructs`
   */

  // write # states that were updated - i.e. the clients
  encoding__namespace.writeVarUint(restEncoder, lazyWriter.clientStructs.length);

  for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
    const partStructs = lazyWriter.clientStructs[i];
    /**
     * Works similarly to `writeStructs`
     */
    // write # encoded structs
    encoding__namespace.writeVarUint(restEncoder, partStructs.written);
    // write the rest of the fragment
    encoding__namespace.writeUint8Array(restEncoder, partStructs.restEncoder);
  }
};

/**
 * @param {Uint8Array} update
 * @param {function(Item|GC|Skip):Item|GC|Skip} blockTransformer
 * @param {typeof UpdateDecoderV2 | typeof UpdateDecoderV1} YDecoder
 * @param {typeof UpdateEncoderV2 | typeof UpdateEncoderV1 } YEncoder
 */
const convertUpdateFormat = (update, blockTransformer, YDecoder, YEncoder) => {
  const updateDecoder = new YDecoder(decoding__namespace.createDecoder(update));
  const lazyDecoder = new LazyStructReader(updateDecoder, false);
  const updateEncoder = new YEncoder();
  const lazyWriter = new LazyStructWriter(updateEncoder);
  for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
    writeStructToLazyStructWriter(lazyWriter, blockTransformer(curr), 0);
  }
  finishLazyStructWriting(lazyWriter);
  const ds = readDeleteSet(updateDecoder);
  writeDeleteSet(updateEncoder, ds);
  return updateEncoder.toUint8Array()
};

/**
 * @typedef {Object} ObfuscatorOptions
 * @property {boolean} [ObfuscatorOptions.formatting=true]
 * @property {boolean} [ObfuscatorOptions.subdocs=true]
 * @property {boolean} [ObfuscatorOptions.yxml=true] Whether to obfuscate nodeName / hookName
 */

/**
 * @param {ObfuscatorOptions} obfuscator
 */
const createObfuscator = ({ formatting = true, subdocs = true, yxml = true } = {}) => {
  let i = 0;
  const mapKeyCache = map__namespace.create();
  const nodeNameCache = map__namespace.create();
  const formattingKeyCache = map__namespace.create();
  const formattingValueCache = map__namespace.create();
  formattingValueCache.set(null, null); // end of a formatting range should always be the end of a formatting range
  /**
   * @param {Item|GC|Skip} block
   * @return {Item|GC|Skip}
   */
  return block => {
    switch (block.constructor) {
      case GC:
      case Skip:
        return block
      case Item: {
        const item = /** @type {Item} */ (block);
        const content = item.content;
        switch (content.constructor) {
          case ContentDeleted:
            break
          case ContentType: {
            if (yxml) {
              const type = /** @type {ContentType} */ (content).type;
              if (type instanceof YXmlElement) {
                type.nodeName = map__namespace.setIfUndefined(nodeNameCache, type.nodeName, () => 'node-' + i);
              }
              if (type instanceof YXmlHook) {
                type.hookName = map__namespace.setIfUndefined(nodeNameCache, type.hookName, () => 'hook-' + i);
              }
            }
            break
          }
          case ContentAny: {
            const c = /** @type {ContentAny} */ (content);
            c.arr = c.arr.map(() => i);
            break
          }
          case ContentBinary: {
            const c = /** @type {ContentBinary} */ (content);
            c.content = new Uint8Array([i]);
            break
          }
          case ContentDoc: {
            const c = /** @type {ContentDoc} */ (content);
            if (subdocs) {
              c.opts = {};
              c.doc.guid = i + '';
            }
            break
          }
          case ContentEmbed: {
            const c = /** @type {ContentEmbed} */ (content);
            c.embed = {};
            break
          }
          case ContentFormat: {
            const c = /** @type {ContentFormat} */ (content);
            if (formatting) {
              c.key = map__namespace.setIfUndefined(formattingKeyCache, c.key, () => i + '');
              c.value = map__namespace.setIfUndefined(formattingValueCache, c.value, () => ({ i }));
            }
            break
          }
          case ContentJSON: {
            const c = /** @type {ContentJSON} */ (content);
            c.arr = c.arr.map(() => i);
            break
          }
          case ContentString: {
            const c = /** @type {ContentString} */ (content);
            c.str = string__namespace.repeat((i % 10) + '', c.str.length);
            break
          }
          default:
            // unknown content type
            error__namespace.unexpectedCase();
        }
        if (item.parentSub) {
          item.parentSub = map__namespace.setIfUndefined(mapKeyCache, item.parentSub, () => i + '');
        }
        i++;
        return block
      }
      default:
        // unknown block-type
        error__namespace.unexpectedCase();
    }
  }
};

/**
 * This function obfuscates the content of a Yjs update. This is useful to share
 * buggy Yjs documents while significantly limiting the possibility that a
 * developer can on the user. Note that it might still be possible to deduce
 * some information by analyzing the "structure" of the document or by analyzing
 * the typing behavior using the CRDT-related metadata that is still kept fully
 * intact.
 *
 * @param {Uint8Array} update
 * @param {ObfuscatorOptions} [opts]
 */
const obfuscateUpdate = (update, opts) => convertUpdateFormat(update, createObfuscator(opts), UpdateDecoderV1, UpdateEncoderV1);

/**
 * @param {Uint8Array} update
 * @param {ObfuscatorOptions} [opts]
 */
const obfuscateUpdateV2 = (update, opts) => convertUpdateFormat(update, createObfuscator(opts), UpdateDecoderV2, UpdateEncoderV2);

/**
 * @param {Uint8Array} update
 */
const convertUpdateFormatV1ToV2 = update => convertUpdateFormat(update, f__namespace.id, UpdateDecoderV1, UpdateEncoderV2);

/**
 * @param {Uint8Array} update
 */
const convertUpdateFormatV2ToV1 = update => convertUpdateFormat(update, f__namespace.id, UpdateDecoderV2, UpdateEncoderV1);

const errorComputeChanges = 'You must not compute changes after the event-handler fired.';

/**
 * @template {AbstractType<any>} T
 * YEvent describes the changes on a YType.
 */
class YEvent {
  /**
   * @param {T} target The changed type.
   * @param {Transaction} transaction
   */
  constructor (target, transaction) {
    /**
     * The type on which this event was created on.
     * @type {T}
     */
    this.target = target;
    /**
     * The current target on which the observe callback is called.
     * @type {AbstractType<any>}
     */
    this.currentTarget = target;
    /**
     * The transaction that triggered this event.
     * @type {Transaction}
     */
    this.transaction = transaction;
    /**
     * @type {Object|null}
     */
    this._changes = null;
    /**
     * @type {null | Map<string, { action: 'add' | 'update' | 'delete', oldValue: any, newValue: any }>}
     */
    this._keys = null;
    /**
     * @type {null | Array<{ insert?: string | Array<any> | object | AbstractType<any>, retain?: number, delete?: number, attributes?: Object<string, any> }>}
     */
    this._delta = null;
    /**
     * @type {Array<string|number>|null}
     */
    this._path = null;
  }

  /**
   * Computes the path from `y` to the changed type.
   *
   * @todo v14 should standardize on path: Array<{parent, index}> because that is easier to work with.
   *
   * The following property holds:
   * @example
   *   let type = y
   *   event.path.forEach(dir => {
   *     type = type.get(dir)
   *   })
   *   type === event.target // => true
   */
  get path () {
    return this._path || (this._path = getPathTo(this.currentTarget, this.target))
  }

  /**
   * Check if a struct is deleted by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  deletes (struct) {
    return isDeleted(this.transaction.deleteSet, struct.id)
  }

  /**
   * @type {Map<string, { action: 'add' | 'update' | 'delete', oldValue: any, newValue: any }>}
   */
  get keys () {
    if (this._keys === null) {
      if (this.transaction.doc._transactionCleanups.length === 0) {
        throw error__namespace.create(errorComputeChanges)
      }
      const keys = new Map();
      const target = this.target;
      const changed = /** @type Set<string|null> */ (this.transaction.changed.get(target));
      changed.forEach(key => {
        if (key !== null) {
          const item = /** @type {Item} */ (target._map.get(key));
          /**
           * @type {'delete' | 'add' | 'update'}
           */
          let action;
          let oldValue;
          if (this.adds(item)) {
            let prev = item.left;
            while (prev !== null && this.adds(prev)) {
              prev = prev.left;
            }
            if (this.deletes(item)) {
              if (prev !== null && this.deletes(prev)) {
                action = 'delete';
                oldValue = array__namespace.last(prev.content.getContent());
              } else {
                return
              }
            } else {
              if (prev !== null && this.deletes(prev)) {
                action = 'update';
                oldValue = array__namespace.last(prev.content.getContent());
              } else {
                action = 'add';
                oldValue = undefined;
              }
            }
          } else {
            if (this.deletes(item)) {
              action = 'delete';
              oldValue = array__namespace.last(/** @type {Item} */ item.content.getContent());
            } else {
              return // nop
            }
          }
          keys.set(key, { action, oldValue });
        }
      });
      this._keys = keys;
    }
    return this._keys
  }

  /**
   * This is a computed property. Note that this can only be safely computed during the
   * event call. Computing this property after other changes happened might result in
   * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
   * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
   *
   * @type {Array<{insert?: string | Array<any> | object | AbstractType<any>, retain?: number, delete?: number, attributes?: Object<string, any>}>}
   */
  get delta () {
    return this.changes.delta
  }

  /**
   * Check if a struct is added by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  adds (struct) {
    return struct.id.clock >= (this.transaction.beforeState.get(struct.id.client) || 0)
  }

  /**
   * This is a computed property. Note that this can only be safely computed during the
   * event call. Computing this property after other changes happened might result in
   * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
   * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
   *
   * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
   */
  get changes () {
    let changes = this._changes;
    if (changes === null) {
      if (this.transaction.doc._transactionCleanups.length === 0) {
        throw error__namespace.create(errorComputeChanges)
      }
      const target = this.target;
      const added = set__namespace.create();
      const deleted = set__namespace.create();
      /**
       * @type {Array<{insert:Array<any>}|{delete:number}|{retain:number}>}
       */
      const delta = [];
      changes = {
        added,
        deleted,
        delta,
        keys: this.keys
      };
      const changed = /** @type Set<string|null> */ (this.transaction.changed.get(target));
      if (changed.has(null)) {
        /**
         * @type {any}
         */
        let lastOp = null;
        const packOp = () => {
          if (lastOp) {
            delta.push(lastOp);
          }
        };
        for (let item = target._start; item !== null; item = item.right) {
          if (item.deleted) {
            if (this.deletes(item) && !this.adds(item)) {
              if (lastOp === null || lastOp.delete === undefined) {
                packOp();
                lastOp = { delete: 0 };
              }
              lastOp.delete += item.length;
              deleted.add(item);
            } // else nop
          } else {
            if (this.adds(item)) {
              if (lastOp === null || lastOp.insert === undefined) {
                packOp();
                lastOp = { insert: [] };
              }
              lastOp.insert = lastOp.insert.concat(item.content.getContent());
              added.add(item);
            } else {
              if (lastOp === null || lastOp.retain === undefined) {
                packOp();
                lastOp = { retain: 0 };
              }
              lastOp.retain += item.length;
            }
          }
        }
        if (lastOp !== null && lastOp.retain === undefined) {
          packOp();
        }
      }
      this._changes = changes;
    }
    return /** @type {any} */ (changes)
  }
}

/**
 * Compute the path from this type to the specified target.
 *
 * @example
 *   // `child` should be accessible via `type.get(path[0]).get(path[1])..`
 *   const path = type.getPathTo(child)
 *   // assuming `type instanceof YArray`
 *   console.log(path) // might look like => [2, 'key1']
 *   child === type.get(path[0]).get(path[1])
 *
 * @param {AbstractType<any>} parent
 * @param {AbstractType<any>} child target
 * @return {Array<string|number>} Path to the target
 *
 * @private
 * @function
 */
const getPathTo = (parent, child) => {
  const path = [];
  while (child._item !== null && child !== parent) {
    if (child._item.parentSub !== null) {
      // parent is map-ish
      path.unshift(child._item.parentSub);
    } else {
      // parent is array-ish
      let i = 0;
      let c = /** @type {AbstractType<any>} */ (child._item.parent)._start;
      while (c !== child._item && c !== null) {
        if (!c.deleted && c.countable) {
          i += c.length;
        }
        c = c.right;
      }
      path.unshift(i);
    }
    child = /** @type {AbstractType<any>} */ (child._item.parent);
  }
  return path
};

const maxSearchMarker = 80;

/**
 * A unique timestamp that identifies each marker.
 *
 * Time is relative,.. this is more like an ever-increasing clock.
 *
 * @type {number}
 */
let globalSearchMarkerTimestamp = 0;

class ArraySearchMarker {
  /**
   * @param {Item} p
   * @param {number} index
   */
  constructor (p, index) {
    p.marker = true;
    this.p = p;
    this.index = index;
    this.timestamp = globalSearchMarkerTimestamp++;
  }
}

/**
 * @param {ArraySearchMarker} marker
 */
const refreshMarkerTimestamp = marker => { marker.timestamp = globalSearchMarkerTimestamp++; };

/**
 * This is rather complex so this function is the only thing that should overwrite a marker
 *
 * @param {ArraySearchMarker} marker
 * @param {Item} p
 * @param {number} index
 */
const overwriteMarker = (marker, p, index) => {
  marker.p.marker = false;
  marker.p = p;
  p.marker = true;
  marker.index = index;
  marker.timestamp = globalSearchMarkerTimestamp++;
};

/**
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {Item} p
 * @param {number} index
 */
const markPosition = (searchMarker, p, index) => {
  if (searchMarker.length >= maxSearchMarker) {
    // override oldest marker (we don't want to create more objects)
    const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b);
    overwriteMarker(marker, p, index);
    return marker
  } else {
    // create new marker
    const pm = new ArraySearchMarker(p, index);
    searchMarker.push(pm);
    return pm
  }
};

/**
 * Search marker help us to find positions in the associative array faster.
 *
 * They speed up the process of finding a position without much bookkeeping.
 *
 * A maximum of `maxSearchMarker` objects are created.
 *
 * This function always returns a refreshed marker (updated timestamp)
 *
 * @param {AbstractType<any>} yarray
 * @param {number} index
 */
const findMarker = (yarray, index) => {
  if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
    return null
  }
  const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => math__namespace.abs(index - a.index) < math__namespace.abs(index - b.index) ? a : b);
  let p = yarray._start;
  let pindex = 0;
  if (marker !== null) {
    p = marker.p;
    pindex = marker.index;
    refreshMarkerTimestamp(marker); // we used it, we might need to use it again
  }
  // iterate to right if possible
  while (p.right !== null && pindex < index) {
    if (!p.deleted && p.countable) {
      if (index < pindex + p.length) {
        break
      }
      pindex += p.length;
    }
    p = p.right;
  }
  // iterate to left if necessary (might be that pindex > index)
  while (p.left !== null && pindex > index) {
    p = p.left;
    if (!p.deleted && p.countable) {
      pindex -= p.length;
    }
  }
  // we want to make sure that p can't be merged with left, because that would screw up everything
  // in that cas just return what we have (it is most likely the best marker anyway)
  // iterate to left until p can't be merged with left
  while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
    p = p.left;
    if (!p.deleted && p.countable) {
      pindex -= p.length;
    }
  }

  // @todo remove!
  // assure position
  // {
  //   let start = yarray._start
  //   let pos = 0
  //   while (start !== p) {
  //     if (!start.deleted && start.countable) {
  //       pos += start.length
  //     }
  //     start = /** @type {Item} */ (start.right)
  //   }
  //   if (pos !== pindex) {
  //     debugger
  //     throw new Error('Gotcha position fail!')
  //   }
  // }
  // if (marker) {
  //   if (window.lengthes == null) {
  //     window.lengthes = []
  //     window.getLengthes = () => window.lengthes.sort((a, b) => a - b)
  //   }
  //   window.lengthes.push(marker.index - pindex)
  //   console.log('distance', marker.index - pindex, 'len', p && p.parent.length)
  // }
  if (marker !== null && math__namespace.abs(marker.index - pindex) < /** @type {YText|YArray<any>} */ (p.parent).length / maxSearchMarker) {
    // adjust existing marker
    overwriteMarker(marker, p, pindex);
    return marker
  } else {
    // create new marker
    return markPosition(yarray._searchMarker, p, pindex)
  }
};

/**
 * Update markers when a change happened.
 *
 * This should be called before doing a deletion!
 *
 * @param {Array<ArraySearchMarker>} searchMarker
 * @param {number} index
 * @param {number} len If insertion, len is positive. If deletion, len is negative.
 */
const updateMarkerChanges = (searchMarker, index, len) => {
  for (let i = searchMarker.length - 1; i >= 0; i--) {
    const m = searchMarker[i];
    if (len > 0) {
      /**
       * @type {Item|null}
       */
      let p = m.p;
      p.marker = false;
      // Ideally we just want to do a simple position comparison, but this will only work if
      // search markers don't point to deleted items for formats.
      // Iterate marker to prev undeleted countable position so we know what to do when updating a position
      while (p && (p.deleted || !p.countable)) {
        p = p.left;
        if (p && !p.deleted && p.countable) {
          // adjust position. the loop should break now
          m.index -= p.length;
        }
      }
      if (p === null || p.marker === true) {
        // remove search marker if updated position is null or if position is already marked
        searchMarker.splice(i, 1);
        continue
      }
      m.p = p;
      p.marker = true;
    }
    if (index < m.index || (len > 0 && index === m.index)) { // a simple index <= m.index check would actually suffice
      m.index = math__namespace.max(index, m.index + len);
    }
  }
};

/**
 * Accumulate all (list) children of a type and return them as an Array.
 *
 * @param {AbstractType<any>} t
 * @return {Array<Item>}
 */
const getTypeChildren = t => {
  let s = t._start;
  const arr = [];
  while (s) {
    arr.push(s);
    s = s.right;
  }
  return arr
};

/**
 * Call event listeners with an event. This will also add an event to all
 * parents (for `.observeDeep` handlers).
 *
 * @template EventType
 * @param {AbstractType<EventType>} type
 * @param {Transaction} transaction
 * @param {EventType} event
 */
const callTypeObservers = (type, transaction, event) => {
  const changedType = type;
  const changedParentTypes = transaction.changedParentTypes;
  while (true) {
    // @ts-ignore
    map__namespace.setIfUndefined(changedParentTypes, type, () => []).push(event);
    if (type._item === null) {
      break
    }
    type = /** @type {AbstractType<any>} */ (type._item.parent);
  }
  callEventHandlerListeners(changedType._eH, event, transaction);
};

/**
 * @template EventType
 * Abstract Yjs Type class
 */
class AbstractType {
  constructor () {
    /**
     * @type {Item|null}
     */
    this._item = null;
    /**
     * @type {Map<string,Item>}
     */
    this._map = new Map();
    /**
     * @type {Item|null}
     */
    this._start = null;
    /**
     * @type {Doc|null}
     */
    this.doc = null;
    this._length = 0;
    /**
     * Event handlers
     * @type {EventHandler<EventType,Transaction>}
     */
    this._eH = createEventHandler();
    /**
     * Deep event handlers
     * @type {EventHandler<Array<YEvent<any>>,Transaction>}
     */
    this._dEH = createEventHandler();
    /**
     * @type {null | Array<ArraySearchMarker>}
     */
    this._searchMarker = null;
  }

  /**
   * @return {AbstractType<any>|null}
   */
  get parent () {
    return this._item ? /** @type {AbstractType<any>} */ (this._item.parent) : null
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item|null} item
   */
  _integrate (y, item) {
    this.doc = y;
    this._item = item;
  }

  /**
   * @return {AbstractType<EventType>}
   */
  _copy () {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {AbstractType<EventType>}
   */
  clone () {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
   */
  _write (_encoder) { }

  /**
   * The first non-deleted item
   */
  get _first () {
    let n = this._start;
    while (n !== null && n.deleted) {
      n = n.right;
    }
    return n
  }

  /**
   * Creates YEvent and calls all type observers.
   * Must be implemented by each type.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} _parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, _parentSubs) {
    if (!transaction.local && this._searchMarker) {
      this._searchMarker.length = 0;
    }
  }

  /**
   * Observe all events that are created on this type.
   *
   * @param {function(EventType, Transaction):void} f Observer function
   */
  observe (f) {
    addEventHandlerListener(this._eH, f);
  }

  /**
   * Observe all events that are created by this type and its children.
   *
   * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
   */
  observeDeep (f) {
    addEventHandlerListener(this._dEH, f);
  }

  /**
   * Unregister an observer function.
   *
   * @param {function(EventType,Transaction):void} f Observer function
   */
  unobserve (f) {
    removeEventHandlerListener(this._eH, f);
  }

  /**
   * Unregister an observer function.
   *
   * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
   */
  unobserveDeep (f) {
    removeEventHandlerListener(this._dEH, f);
  }

  /**
   * @abstract
   * @return {any}
   */
  toJSON () {}
}

/**
 * @param {AbstractType<any>} type
 * @param {number} start
 * @param {number} end
 * @return {Array<any>}
 *
 * @private
 * @function
 */
const typeListSlice = (type, start, end) => {
  if (start < 0) {
    start = type._length + start;
  }
  if (end < 0) {
    end = type._length + end;
  }
  let len = end - start;
  const cs = [];
  let n = type._start;
  while (n !== null && len > 0) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent();
      if (c.length <= start) {
        start -= c.length;
      } else {
        for (let i = start; i < c.length && len > 0; i++) {
          cs.push(c[i]);
          len--;
        }
        start = 0;
      }
    }
    n = n.right;
  }
  return cs
};

/**
 * @param {AbstractType<any>} type
 * @return {Array<any>}
 *
 * @private
 * @function
 */
const typeListToArray = type => {
  const cs = [];
  let n = type._start;
  while (n !== null) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent();
      for (let i = 0; i < c.length; i++) {
        cs.push(c[i]);
      }
    }
    n = n.right;
  }
  return cs
};

/**
 * @param {AbstractType<any>} type
 * @param {Snapshot} snapshot
 * @return {Array<any>}
 *
 * @private
 * @function
 */
const typeListToArraySnapshot = (type, snapshot) => {
  const cs = [];
  let n = type._start;
  while (n !== null) {
    if (n.countable && isVisible(n, snapshot)) {
      const c = n.content.getContent();
      for (let i = 0; i < c.length; i++) {
        cs.push(c[i]);
      }
    }
    n = n.right;
  }
  return cs
};

/**
 * Executes a provided function on once on every element of this YArray.
 *
 * @param {AbstractType<any>} type
 * @param {function(any,number,any):void} f A function to execute on every element of this YArray.
 *
 * @private
 * @function
 */
const typeListForEach = (type, f) => {
  let index = 0;
  let n = type._start;
  while (n !== null) {
    if (n.countable && !n.deleted) {
      const c = n.content.getContent();
      for (let i = 0; i < c.length; i++) {
        f(c[i], index++, type);
      }
    }
    n = n.right;
  }
};

/**
 * @template C,R
 * @param {AbstractType<any>} type
 * @param {function(C,number,AbstractType<any>):R} f
 * @return {Array<R>}
 *
 * @private
 * @function
 */
const typeListMap = (type, f) => {
  /**
   * @type {Array<any>}
   */
  const result = [];
  typeListForEach(type, (c, i) => {
    result.push(f(c, i, type));
  });
  return result
};

/**
 * @param {AbstractType<any>} type
 * @return {IterableIterator<any>}
 *
 * @private
 * @function
 */
const typeListCreateIterator = type => {
  let n = type._start;
  /**
   * @type {Array<any>|null}
   */
  let currentContent = null;
  let currentContentIndex = 0;
  return {
    [Symbol.iterator] () {
      return this
    },
    next: () => {
      // find some content
      if (currentContent === null) {
        while (n !== null && n.deleted) {
          n = n.right;
        }
        // check if we reached the end, no need to check currentContent, because it does not exist
        if (n === null) {
          return {
            done: true,
            value: undefined
          }
        }
        // we found n, so we can set currentContent
        currentContent = n.content.getContent();
        currentContentIndex = 0;
        n = n.right; // we used the content of n, now iterate to next
      }
      const value = currentContent[currentContentIndex++];
      // check if we need to empty currentContent
      if (currentContent.length <= currentContentIndex) {
        currentContent = null;
      }
      return {
        done: false,
        value
      }
    }
  }
};

/**
 * @param {AbstractType<any>} type
 * @param {number} index
 * @return {any}
 *
 * @private
 * @function
 */
const typeListGet = (type, index) => {
  const marker = findMarker(type, index);
  let n = type._start;
  if (marker !== null) {
    n = marker.p;
    index -= marker.index;
  }
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        return n.content.getContent()[index]
      }
      index -= n.length;
    }
  }
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {Item?} referenceItem
 * @param {Array<Object<string,any>|Array<any>|boolean|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
const typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
  let left = referenceItem;
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  const store = doc.store;
  const right = referenceItem === null ? parent._start : referenceItem.right;
  /**
   * @type {Array<Object|Array<any>|number|null>}
   */
  let jsonContent = [];
  const packJsonContent = () => {
    if (jsonContent.length > 0) {
      left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentAny(jsonContent));
      left.integrate(transaction, 0);
      jsonContent = [];
    }
  };
  content.forEach(c => {
    if (c === null) {
      jsonContent.push(c);
    } else {
      switch (c.constructor) {
        case Number:
        case Object:
        case Boolean:
        case Array:
        case String:
          jsonContent.push(c);
          break
        default:
          packJsonContent();
          switch (c.constructor) {
            case Uint8Array:
            case ArrayBuffer:
              left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentBinary(new Uint8Array(/** @type {Uint8Array} */ (c))));
              left.integrate(transaction, 0);
              break
            case Doc:
              left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentDoc(/** @type {Doc} */ (c)));
              left.integrate(transaction, 0);
              break
            default:
              if (c instanceof AbstractType) {
                left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentType(c));
                left.integrate(transaction, 0);
              } else {
                throw new Error('Unexpected content type in insert operation')
              }
          }
      }
    }
  });
  packJsonContent();
};

const lengthExceeded = () => error__namespace.create('Length exceeded!');

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {number} index
 * @param {Array<Object<string,any>|Array<any>|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
const typeListInsertGenerics = (transaction, parent, index, content) => {
  if (index > parent._length) {
    throw lengthExceeded()
  }
  if (index === 0) {
    if (parent._searchMarker) {
      updateMarkerChanges(parent._searchMarker, index, content.length);
    }
    return typeListInsertGenericsAfter(transaction, parent, null, content)
  }
  const startIndex = index;
  const marker = findMarker(parent, index);
  let n = parent._start;
  if (marker !== null) {
    n = marker.p;
    index -= marker.index;
    // we need to iterate one to the left so that the algorithm works
    if (index === 0) {
      // @todo refactor this as it actually doesn't consider formats
      n = n.prev; // important! get the left undeleted item so that we can actually decrease index
      index += (n && n.countable && !n.deleted) ? n.length : 0;
    }
  }
  for (; n !== null; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index <= n.length) {
        if (index < n.length) {
          // insert in-between
          getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
        }
        break
      }
      index -= n.length;
    }
  }
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, startIndex, content.length);
  }
  return typeListInsertGenericsAfter(transaction, parent, n, content)
};

/**
 * Pushing content is special as we generally want to push after the last item. So we don't have to update
 * the serach marker.
 *
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {Array<Object<string,any>|Array<any>|number|null|string|Uint8Array>} content
 *
 * @private
 * @function
 */
const typeListPushGenerics = (transaction, parent, content) => {
  // Use the marker with the highest index and iterate to the right.
  const marker = (parent._searchMarker || []).reduce((maxMarker, currMarker) => currMarker.index > maxMarker.index ? currMarker : maxMarker, { index: 0, p: parent._start });
  let n = marker.p;
  if (n) {
    while (n.right) {
      n = n.right;
    }
  }
  return typeListInsertGenericsAfter(transaction, parent, n, content)
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {number} index
 * @param {number} length
 *
 * @private
 * @function
 */
const typeListDelete = (transaction, parent, index, length) => {
  if (length === 0) { return }
  const startIndex = index;
  const startLength = length;
  const marker = findMarker(parent, index);
  let n = parent._start;
  if (marker !== null) {
    n = marker.p;
    index -= marker.index;
  }
  // compute the first item to be deleted
  for (; n !== null && index > 0; n = n.right) {
    if (!n.deleted && n.countable) {
      if (index < n.length) {
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
      }
      index -= n.length;
    }
  }
  // delete all items until done
  while (length > 0 && n !== null) {
    if (!n.deleted) {
      if (length < n.length) {
        getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length));
      }
      n.delete(transaction);
      length -= n.length;
    }
    n = n.right;
  }
  if (length > 0) {
    throw lengthExceeded()
  }
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, startIndex, -startLength + length /* in case we remove the above exception */);
  }
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {string} key
 *
 * @private
 * @function
 */
const typeMapDelete = (transaction, parent, key) => {
  const c = parent._map.get(key);
  if (c !== undefined) {
    c.delete(transaction);
  }
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @param {Object|number|null|Array<any>|string|Uint8Array|AbstractType<any>} value
 *
 * @private
 * @function
 */
const typeMapSet = (transaction, parent, key, value) => {
  const left = parent._map.get(key) || null;
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  let content;
  if (value == null) {
    content = new ContentAny([value]);
  } else {
    switch (value.constructor) {
      case Number:
      case Object:
      case Boolean:
      case Array:
      case String:
        content = new ContentAny([value]);
        break
      case Uint8Array:
        content = new ContentBinary(/** @type {Uint8Array} */ (value));
        break
      case Doc:
        content = new ContentDoc(/** @type {Doc} */ (value));
        break
      default:
        if (value instanceof AbstractType) {
          content = new ContentType(value);
        } else {
          throw new Error('Unexpected content type')
        }
    }
  }
  new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0);
};

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined}
 *
 * @private
 * @function
 */
const typeMapGet = (parent, key) => {
  const val = parent._map.get(key);
  return val !== undefined && !val.deleted ? val.content.getContent()[val.length - 1] : undefined
};

/**
 * @param {AbstractType<any>} parent
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined>}
 *
 * @private
 * @function
 */
const typeMapGetAll = (parent) => {
  /**
   * @type {Object<string,any>}
   */
  const res = {};
  parent._map.forEach((value, key) => {
    if (!value.deleted) {
      res[key] = value.content.getContent()[value.length - 1];
    }
  });
  return res
};

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @return {boolean}
 *
 * @private
 * @function
 */
const typeMapHas = (parent, key) => {
  const val = parent._map.get(key);
  return val !== undefined && !val.deleted
};

/**
 * @param {AbstractType<any>} parent
 * @param {string} key
 * @param {Snapshot} snapshot
 * @return {Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined}
 *
 * @private
 * @function
 */
const typeMapGetSnapshot = (parent, key, snapshot) => {
  let v = parent._map.get(key) || null;
  while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
    v = v.left;
  }
  return v !== null && isVisible(v, snapshot) ? v.content.getContent()[v.length - 1] : undefined
};

/**
 * @param {AbstractType<any>} parent
 * @param {Snapshot} snapshot
 * @return {Object<string,Object<string,any>|number|null|Array<any>|string|Uint8Array|AbstractType<any>|undefined>}
 *
 * @private
 * @function
 */
const typeMapGetAllSnapshot = (parent, snapshot) => {
  /**
   * @type {Object<string,any>}
   */
  const res = {};
  parent._map.forEach((value, key) => {
    /**
     * @type {Item|null}
     */
    let v = value;
    while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
      v = v.left;
    }
    if (v !== null && isVisible(v, snapshot)) {
      res[key] = v.content.getContent()[v.length - 1];
    }
  });
  return res
};

/**
 * @param {Map<string,Item>} map
 * @return {IterableIterator<Array<any>>}
 *
 * @private
 * @function
 */
const createMapIterator = map => iterator__namespace.iteratorFilter(map.entries(), /** @param {any} entry */ entry => !entry[1].deleted);

/**
 * @module YArray
 */


/**
 * Event that describes the changes on a YArray
 * @template T
 * @extends YEvent<YArray<T>>
 */
class YArrayEvent extends YEvent {}

/**
 * A shared Array implementation.
 * @template T
 * @extends AbstractType<YArrayEvent<T>>
 * @implements {Iterable<T>}
 */
class YArray extends AbstractType {
  constructor () {
    super();
    /**
     * @type {Array<any>?}
     * @private
     */
    this._prelimContent = [];
    /**
     * @type {Array<ArraySearchMarker>}
     */
    this._searchMarker = [];
  }

  /**
   * Construct a new YArray containing the specified items.
   * @template {Object<string,any>|Array<any>|number|null|string|Uint8Array} T
   * @param {Array<T>} items
   * @return {YArray<T>}
   */
  static from (items) {
    /**
     * @type {YArray<T>}
     */
    const a = new YArray();
    a.push(items);
    return a
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item);
    this.insert(0, /** @type {Array<any>} */ (this._prelimContent));
    this._prelimContent = null;
  }

  /**
   * @return {YArray<T>}
   */
  _copy () {
    return new YArray()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YArray<T>}
   */
  clone () {
    /**
     * @type {YArray<T>}
     */
    const arr = new YArray();
    arr.insert(0, this.toArray().map(el =>
      el instanceof AbstractType ? /** @type {typeof el} */ (el.clone()) : el
    ));
    return arr
  }

  get length () {
    return this._prelimContent === null ? this._length : this._prelimContent.length
  }

  /**
   * Creates YArrayEvent and calls observers.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    super._callObserver(transaction, parentSubs);
    callTypeObservers(this, transaction, new YArrayEvent(this, transaction));
  }

  /**
   * Inserts new content at an index.
   *
   * Important: This function expects an array of content. Not just a content
   * object. The reason for this "weirdness" is that inserting several elements
   * is very efficient when it is done as a single operation.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  yarray.insert(0, ['a'])
   *  // Insert numbers 1, 2 at position 1
   *  yarray.insert(1, [1, 2])
   *
   * @param {number} index The index to insert content at.
   * @param {Array<T>} content The array of content
   */
  insert (index, content) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListInsertGenerics(transaction, this, index, /** @type {any} */ (content));
      });
    } else {
      /** @type {Array<any>} */ (this._prelimContent).splice(index, 0, ...content);
    }
  }

  /**
   * Appends content to this YArray.
   *
   * @param {Array<T>} content Array of content to append.
   *
   * @todo Use the following implementation in all types.
   */
  push (content) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListPushGenerics(transaction, this, /** @type {any} */ (content));
      });
    } else {
      /** @type {Array<any>} */ (this._prelimContent).push(...content);
    }
  }

  /**
   * Prepends content to this YArray.
   *
   * @param {Array<T>} content Array of content to prepend.
   */
  unshift (content) {
    this.insert(0, content);
  }

  /**
   * Deletes elements starting from an index.
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} length The number of elements to remove. Defaults to 1.
   */
  delete (index, length = 1) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListDelete(transaction, this, index, length);
      });
    } else {
      /** @type {Array<any>} */ (this._prelimContent).splice(index, length);
    }
  }

  /**
   * Returns the i-th element from a YArray.
   *
   * @param {number} index The index of the element to return from the YArray
   * @return {T}
   */
  get (index) {
    return typeListGet(this, index)
  }

  /**
   * Transforms this YArray to a JavaScript Array.
   *
   * @return {Array<T>}
   */
  toArray () {
    return typeListToArray(this)
  }

  /**
   * Returns a portion of this YArray into a JavaScript Array selected
   * from start to end (end not included).
   *
   * @param {number} [start]
   * @param {number} [end]
   * @return {Array<T>}
   */
  slice (start = 0, end = this.length) {
    return typeListSlice(this, start, end)
  }

  /**
   * Transforms this Shared Type to a JSON object.
   *
   * @return {Array<any>}
   */
  toJSON () {
    return this.map(c => c instanceof AbstractType ? c.toJSON() : c)
  }

  /**
   * Returns an Array with the result of calling a provided function on every
   * element of this YArray.
   *
   * @template M
   * @param {function(T,number,YArray<T>):M} f Function that produces an element of the new Array
   * @return {Array<M>} A new array with each element being the result of the
   *                 callback function
   */
  map (f) {
    return typeListMap(this, /** @type {any} */ (f))
  }

  /**
   * Executes a provided function once on every element of this YArray.
   *
   * @param {function(T,number,YArray<T>):void} f A function to execute on every element of this YArray.
   */
  forEach (f) {
    typeListForEach(this, f);
  }

  /**
   * @return {IterableIterator<T>}
   */
  [Symbol.iterator] () {
    return typeListCreateIterator(this)
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  _write (encoder) {
    encoder.writeTypeRef(YArrayRefID);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} _decoder
 *
 * @private
 * @function
 */
const readYArray = _decoder => new YArray();

/**
 * @module YMap
 */


/**
 * @template T
 * @extends YEvent<YMap<T>>
 * Event that describes the changes on a YMap.
 */
class YMapEvent extends YEvent {
  /**
   * @param {YMap<T>} ymap The YArray that changed.
   * @param {Transaction} transaction
   * @param {Set<any>} subs The keys that changed.
   */
  constructor (ymap, transaction, subs) {
    super(ymap, transaction);
    this.keysChanged = subs;
  }
}

/**
 * @template MapType
 * A shared Map implementation.
 *
 * @extends AbstractType<YMapEvent<MapType>>
 * @implements {Iterable<[string, MapType]>}
 */
class YMap extends AbstractType {
  /**
   *
   * @param {Iterable<readonly [string, any]>=} entries - an optional iterable to initialize the YMap
   */
  constructor (entries) {
    super();
    /**
     * @type {Map<string,any>?}
     * @private
     */
    this._prelimContent = null;

    if (entries === undefined) {
      this._prelimContent = new Map();
    } else {
      this._prelimContent = new Map(entries);
    }
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item)
    ;/** @type {Map<string, any>} */ (this._prelimContent).forEach((value, key) => {
      this.set(key, value);
    });
    this._prelimContent = null;
  }

  /**
   * @return {YMap<MapType>}
   */
  _copy () {
    return new YMap()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YMap<MapType>}
   */
  clone () {
    /**
     * @type {YMap<MapType>}
     */
    const map = new YMap();
    this.forEach((value, key) => {
      map.set(key, value instanceof AbstractType ? /** @type {typeof value} */ (value.clone()) : value);
    });
    return map
  }

  /**
   * Creates YMapEvent and calls observers.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    callTypeObservers(this, transaction, new YMapEvent(this, transaction, parentSubs));
  }

  /**
   * Transforms this Shared Type to a JSON object.
   *
   * @return {Object<string,any>}
   */
  toJSON () {
    /**
     * @type {Object<string,MapType>}
     */
    const map = {};
    this._map.forEach((item, key) => {
      if (!item.deleted) {
        const v = item.content.getContent()[item.length - 1];
        map[key] = v instanceof AbstractType ? v.toJSON() : v;
      }
    });
    return map
  }

  /**
   * Returns the size of the YMap (count of key/value pairs)
   *
   * @return {number}
   */
  get size () {
    return [...createMapIterator(this._map)].length
  }

  /**
   * Returns the keys for each element in the YMap Type.
   *
   * @return {IterableIterator<string>}
   */
  keys () {
    return iterator__namespace.iteratorMap(createMapIterator(this._map), /** @param {any} v */ v => v[0])
  }

  /**
   * Returns the values for each element in the YMap Type.
   *
   * @return {IterableIterator<MapType>}
   */
  values () {
    return iterator__namespace.iteratorMap(createMapIterator(this._map), /** @param {any} v */ v => v[1].content.getContent()[v[1].length - 1])
  }

  /**
   * Returns an Iterator of [key, value] pairs
   *
   * @return {IterableIterator<[string, MapType]>}
   */
  entries () {
    return iterator__namespace.iteratorMap(createMapIterator(this._map), /** @param {any} v */ v => /** @type {any} */ ([v[0], v[1].content.getContent()[v[1].length - 1]]))
  }

  /**
   * Executes a provided function on once on every key-value pair.
   *
   * @param {function(MapType,string,YMap<MapType>):void} f A function to execute on every element of this YArray.
   */
  forEach (f) {
    this._map.forEach((item, key) => {
      if (!item.deleted) {
        f(item.content.getContent()[item.length - 1], key, this);
      }
    });
  }

  /**
   * Returns an Iterator of [key, value] pairs
   *
   * @return {IterableIterator<[string, MapType]>}
   */
  [Symbol.iterator] () {
    return this.entries()
  }

  /**
   * Remove a specified element from this YMap.
   *
   * @param {string} key The key of the element to remove.
   */
  delete (key) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapDelete(transaction, this, key);
      });
    } else {
      /** @type {Map<string, any>} */ (this._prelimContent).delete(key);
    }
  }

  /**
   * Adds or updates an element with a specified key and value.
   * @template {MapType} VAL
   *
   * @param {string} key The key of the element to add to this YMap
   * @param {VAL} value The value of the element to add
   * @return {VAL}
   */
  set (key, value) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapSet(transaction, this, key, /** @type {any} */ (value));
      });
    } else {
      /** @type {Map<string, any>} */ (this._prelimContent).set(key, value);
    }
    return value
  }

  /**
   * Returns a specified element from this YMap.
   *
   * @param {string} key
   * @return {MapType|undefined}
   */
  get (key) {
    return /** @type {any} */ (typeMapGet(this, key))
  }

  /**
   * Returns a boolean indicating whether the specified key exists or not.
   *
   * @param {string} key The key to test.
   * @return {boolean}
   */
  has (key) {
    return typeMapHas(this, key)
  }

  /**
   * Removes all elements from this YMap.
   */
  clear () {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        this.forEach(function (_value, key, map) {
          typeMapDelete(transaction, map, key);
        });
      });
    } else {
      /** @type {Map<string, any>} */ (this._prelimContent).clear();
    }
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  _write (encoder) {
    encoder.writeTypeRef(YMapRefID);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} _decoder
 *
 * @private
 * @function
 */
const readYMap = _decoder => new YMap();

/**
 * @module YText
 */


/**
 * @param {any} a
 * @param {any} b
 * @return {boolean}
 */
const equalAttrs = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a && b && object__namespace.equalFlat(a, b));

class ItemTextListPosition {
  /**
   * @param {Item|null} left
   * @param {Item|null} right
   * @param {number} index
   * @param {Map<string,any>} currentAttributes
   */
  constructor (left, right, index, currentAttributes) {
    this.left = left;
    this.right = right;
    this.index = index;
    this.currentAttributes = currentAttributes;
  }

  /**
   * Only call this if you know that this.right is defined
   */
  forward () {
    if (this.right === null) {
      error__namespace.unexpectedCase();
    }
    switch (this.right.content.constructor) {
      case ContentFormat:
        if (!this.right.deleted) {
          updateCurrentAttributes(this.currentAttributes, /** @type {ContentFormat} */ (this.right.content));
        }
        break
      default:
        if (!this.right.deleted) {
          this.index += this.right.length;
        }
        break
    }
    this.left = this.right;
    this.right = this.right.right;
  }
}

/**
 * @param {Transaction} transaction
 * @param {ItemTextListPosition} pos
 * @param {number} count steps to move forward
 * @return {ItemTextListPosition}
 *
 * @private
 * @function
 */
const findNextPosition = (transaction, pos, count) => {
  while (pos.right !== null && count > 0) {
    switch (pos.right.content.constructor) {
      case ContentFormat:
        if (!pos.right.deleted) {
          updateCurrentAttributes(pos.currentAttributes, /** @type {ContentFormat} */ (pos.right.content));
        }
        break
      default:
        if (!pos.right.deleted) {
          if (count < pos.right.length) {
            // split right
            getItemCleanStart(transaction, createID(pos.right.id.client, pos.right.id.clock + count));
          }
          pos.index += pos.right.length;
          count -= pos.right.length;
        }
        break
    }
    pos.left = pos.right;
    pos.right = pos.right.right;
    // pos.forward() - we don't forward because that would halve the performance because we already do the checks above
  }
  return pos
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {number} index
 * @param {boolean} useSearchMarker
 * @return {ItemTextListPosition}
 *
 * @private
 * @function
 */
const findPosition = (transaction, parent, index, useSearchMarker) => {
  const currentAttributes = new Map();
  const marker = useSearchMarker ? findMarker(parent, index) : null;
  if (marker) {
    const pos = new ItemTextListPosition(marker.p.left, marker.p, marker.index, currentAttributes);
    return findNextPosition(transaction, pos, index - marker.index)
  } else {
    const pos = new ItemTextListPosition(null, parent._start, 0, currentAttributes);
    return findNextPosition(transaction, pos, index)
  }
};

/**
 * Negate applied formats
 *
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {ItemTextListPosition} currPos
 * @param {Map<string,any>} negatedAttributes
 *
 * @private
 * @function
 */
const insertNegatedAttributes = (transaction, parent, currPos, negatedAttributes) => {
  // check if we really need to remove attributes
  while (
    currPos.right !== null && (
      currPos.right.deleted === true || (
        currPos.right.content.constructor === ContentFormat &&
        equalAttrs(negatedAttributes.get(/** @type {ContentFormat} */ (currPos.right.content).key), /** @type {ContentFormat} */ (currPos.right.content).value)
      )
    )
  ) {
    if (!currPos.right.deleted) {
      negatedAttributes.delete(/** @type {ContentFormat} */ (currPos.right.content).key);
    }
    currPos.forward();
  }
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  negatedAttributes.forEach((val, key) => {
    const left = currPos.left;
    const right = currPos.right;
    const nextFormat = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
    nextFormat.integrate(transaction, 0);
    currPos.right = nextFormat;
    currPos.forward();
  });
};

/**
 * @param {Map<string,any>} currentAttributes
 * @param {ContentFormat} format
 *
 * @private
 * @function
 */
const updateCurrentAttributes = (currentAttributes, format) => {
  const { key, value } = format;
  if (value === null) {
    currentAttributes.delete(key);
  } else {
    currentAttributes.set(key, value);
  }
};

/**
 * @param {ItemTextListPosition} currPos
 * @param {Object<string,any>} attributes
 *
 * @private
 * @function
 */
const minimizeAttributeChanges = (currPos, attributes) => {
  // go right while attributes[right.key] === right.value (or right is deleted)
  while (true) {
    if (currPos.right === null) {
      break
    } else if (currPos.right.deleted || (currPos.right.content.constructor === ContentFormat && equalAttrs(attributes[(/** @type {ContentFormat} */ (currPos.right.content)).key] ?? null, /** @type {ContentFormat} */ (currPos.right.content).value))) ; else {
      break
    }
    currPos.forward();
  }
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {ItemTextListPosition} currPos
 * @param {Object<string,any>} attributes
 * @return {Map<string,any>}
 *
 * @private
 * @function
 **/
const insertAttributes = (transaction, parent, currPos, attributes) => {
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  const negatedAttributes = new Map();
  // insert format-start items
  for (const key in attributes) {
    const val = attributes[key];
    const currentVal = currPos.currentAttributes.get(key) ?? null;
    if (!equalAttrs(currentVal, val)) {
      // save negated attribute (set null if currentVal undefined)
      negatedAttributes.set(key, currentVal);
      const { left, right } = currPos;
      currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
      currPos.right.integrate(transaction, 0);
      currPos.forward();
    }
  }
  return negatedAttributes
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {ItemTextListPosition} currPos
 * @param {string|object|AbstractType<any>} text
 * @param {Object<string,any>} attributes
 *
 * @private
 * @function
 **/
const insertText = (transaction, parent, currPos, text, attributes) => {
  currPos.currentAttributes.forEach((_val, key) => {
    if (attributes[key] === undefined) {
      attributes[key] = null;
    }
  });
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  minimizeAttributeChanges(currPos, attributes);
  const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
  // insert content
  const content = text.constructor === String ? new ContentString(/** @type {string} */ (text)) : (text instanceof AbstractType ? new ContentType(text) : new ContentEmbed(text));
  let { left, right, index } = currPos;
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength());
  }
  right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, content);
  right.integrate(transaction, 0);
  currPos.right = right;
  currPos.index = index;
  currPos.forward();
  insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
};

/**
 * @param {Transaction} transaction
 * @param {AbstractType<any>} parent
 * @param {ItemTextListPosition} currPos
 * @param {number} length
 * @param {Object<string,any>} attributes
 *
 * @private
 * @function
 */
const formatText = (transaction, parent, currPos, length, attributes) => {
  const doc = transaction.doc;
  const ownClientId = doc.clientID;
  minimizeAttributeChanges(currPos, attributes);
  const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
  // iterate until first non-format or null is found
  // delete all formats with attributes[format.key] != null
  // also check the attributes after the first non-format as we do not want to insert redundant negated attributes there
  // eslint-disable-next-line no-labels
  iterationLoop: while (
    currPos.right !== null &&
    (length > 0 ||
      (
        negatedAttributes.size > 0 &&
        (currPos.right.deleted || currPos.right.content.constructor === ContentFormat)
      )
    )
  ) {
    if (!currPos.right.deleted) {
      switch (currPos.right.content.constructor) {
        case ContentFormat: {
          const { key, value } = /** @type {ContentFormat} */ (currPos.right.content);
          const attr = attributes[key];
          if (attr !== undefined) {
            if (equalAttrs(attr, value)) {
              negatedAttributes.delete(key);
            } else {
              if (length === 0) {
                // no need to further extend negatedAttributes
                // eslint-disable-next-line no-labels
                break iterationLoop
              }
              negatedAttributes.set(key, value);
            }
            currPos.right.delete(transaction);
          } else {
            currPos.currentAttributes.set(key, value);
          }
          break
        }
        default:
          if (length < currPos.right.length) {
            getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length));
          }
          length -= currPos.right.length;
          break
      }
    }
    currPos.forward();
  }
  // Quill just assumes that the editor starts with a newline and that it always
  // ends with a newline. We only insert that newline when a new newline is
  // inserted - i.e when length is bigger than type.length
  if (length > 0) {
    let newlines = '';
    for (; length > 0; length--) {
      newlines += '\n';
    }
    currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), currPos.left, currPos.left && currPos.left.lastId, currPos.right, currPos.right && currPos.right.id, parent, null, new ContentString(newlines));
    currPos.right.integrate(transaction, 0);
    currPos.forward();
  }
  insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
};

/**
 * Call this function after string content has been deleted in order to
 * clean up formatting Items.
 *
 * @param {Transaction} transaction
 * @param {Item} start
 * @param {Item|null} curr exclusive end, automatically iterates to the next Content Item
 * @param {Map<string,any>} startAttributes
 * @param {Map<string,any>} currAttributes
 * @return {number} The amount of formatting Items deleted.
 *
 * @function
 */
const cleanupFormattingGap = (transaction, start, curr, startAttributes, currAttributes) => {
  /**
   * @type {Item|null}
   */
  let end = start;
  /**
   * @type {Map<string,ContentFormat>}
   */
  const endFormats = map__namespace.create();
  while (end && (!end.countable || end.deleted)) {
    if (!end.deleted && end.content.constructor === ContentFormat) {
      const cf = /** @type {ContentFormat} */ (end.content);
      endFormats.set(cf.key, cf);
    }
    end = end.right;
  }
  let cleanups = 0;
  let reachedCurr = false;
  while (start !== end) {
    if (curr === start) {
      reachedCurr = true;
    }
    if (!start.deleted) {
      const content = start.content;
      switch (content.constructor) {
        case ContentFormat: {
          const { key, value } = /** @type {ContentFormat} */ (content);
          const startAttrValue = startAttributes.get(key) ?? null;
          if (endFormats.get(key) !== content || startAttrValue === value) {
            // Either this format is overwritten or it is not necessary because the attribute already existed.
            start.delete(transaction);
            cleanups++;
            if (!reachedCurr && (currAttributes.get(key) ?? null) === value && startAttrValue !== value) {
              if (startAttrValue === null) {
                currAttributes.delete(key);
              } else {
                currAttributes.set(key, startAttrValue);
              }
            }
          }
          if (!reachedCurr && !start.deleted) {
            updateCurrentAttributes(currAttributes, /** @type {ContentFormat} */ (content));
          }
          break
        }
      }
    }
    start = /** @type {Item} */ (start.right);
  }
  return cleanups
};

/**
 * @param {Transaction} transaction
 * @param {Item | null} item
 */
const cleanupContextlessFormattingGap = (transaction, item) => {
  // iterate until item.right is null or content
  while (item && item.right && (item.right.deleted || !item.right.countable)) {
    item = item.right;
  }
  const attrs = new Set();
  // iterate back until a content item is found
  while (item && (item.deleted || !item.countable)) {
    if (!item.deleted && item.content.constructor === ContentFormat) {
      const key = /** @type {ContentFormat} */ (item.content).key;
      if (attrs.has(key)) {
        item.delete(transaction);
      } else {
        attrs.add(key);
      }
    }
    item = item.left;
  }
};

/**
 * This function is experimental and subject to change / be removed.
 *
 * Ideally, we don't need this function at all. Formatting attributes should be cleaned up
 * automatically after each change. This function iterates twice over the complete YText type
 * and removes unnecessary formatting attributes. This is also helpful for testing.
 *
 * This function won't be exported anymore as soon as there is confidence that the YText type works as intended.
 *
 * @param {YText} type
 * @return {number} How many formatting attributes have been cleaned up.
 */
const cleanupYTextFormatting = type => {
  let res = 0;
  transact(/** @type {Doc} */ (type.doc), transaction => {
    let start = /** @type {Item} */ (type._start);
    let end = type._start;
    let startAttributes = map__namespace.create();
    const currentAttributes = map__namespace.copy(startAttributes);
    while (end) {
      if (end.deleted === false) {
        switch (end.content.constructor) {
          case ContentFormat:
            updateCurrentAttributes(currentAttributes, /** @type {ContentFormat} */ (end.content));
            break
          default:
            res += cleanupFormattingGap(transaction, start, end, startAttributes, currentAttributes);
            startAttributes = map__namespace.copy(currentAttributes);
            start = end;
            break
        }
      }
      end = end.right;
    }
  });
  return res
};

/**
 * This will be called by the transction once the event handlers are called to potentially cleanup
 * formatting attributes.
 *
 * @param {Transaction} transaction
 */
const cleanupYTextAfterTransaction = transaction => {
  /**
   * @type {Set<YText>}
   */
  const needFullCleanup = new Set();
  // check if another formatting item was inserted
  const doc = transaction.doc;
  for (const [client, afterClock] of transaction.afterState.entries()) {
    const clock = transaction.beforeState.get(client) || 0;
    if (afterClock === clock) {
      continue
    }
    iterateStructs(transaction, /** @type {Array<Item|GC>} */ (doc.store.clients.get(client)), clock, afterClock, item => {
      if (
        !item.deleted && /** @type {Item} */ (item).content.constructor === ContentFormat && item.constructor !== GC
      ) {
        needFullCleanup.add(/** @type {any} */ (item).parent);
      }
    });
  }
  // cleanup in a new transaction
  transact(doc, (t) => {
    iterateDeletedStructs(transaction, transaction.deleteSet, item => {
      if (item instanceof GC || !(/** @type {YText} */ (item.parent)._hasFormatting) || needFullCleanup.has(/** @type {YText} */ (item.parent))) {
        return
      }
      const parent = /** @type {YText} */ (item.parent);
      if (item.content.constructor === ContentFormat) {
        needFullCleanup.add(parent);
      } else {
        // If no formatting attribute was inserted or deleted, we can make due with contextless
        // formatting cleanups.
        // Contextless: it is not necessary to compute currentAttributes for the affected position.
        cleanupContextlessFormattingGap(t, item);
      }
    });
    // If a formatting item was inserted, we simply clean the whole type.
    // We need to compute currentAttributes for the current position anyway.
    for (const yText of needFullCleanup) {
      cleanupYTextFormatting(yText);
    }
  });
};

/**
 * @param {Transaction} transaction
 * @param {ItemTextListPosition} currPos
 * @param {number} length
 * @return {ItemTextListPosition}
 *
 * @private
 * @function
 */
const deleteText = (transaction, currPos, length) => {
  const startLength = length;
  const startAttrs = map__namespace.copy(currPos.currentAttributes);
  const start = currPos.right;
  while (length > 0 && currPos.right !== null) {
    if (currPos.right.deleted === false) {
      switch (currPos.right.content.constructor) {
        case ContentType:
        case ContentEmbed:
        case ContentString:
          if (length < currPos.right.length) {
            getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length));
          }
          length -= currPos.right.length;
          currPos.right.delete(transaction);
          break
      }
    }
    currPos.forward();
  }
  if (start) {
    cleanupFormattingGap(transaction, start, currPos.right, startAttrs, currPos.currentAttributes);
  }
  const parent = /** @type {AbstractType<any>} */ (/** @type {Item} */ (currPos.left || currPos.right).parent);
  if (parent._searchMarker) {
    updateMarkerChanges(parent._searchMarker, currPos.index, -startLength + length);
  }
  return currPos
};

/**
 * The Quill Delta format represents changes on a text document with
 * formatting information. For mor information visit {@link https://quilljs.com/docs/delta/|Quill Delta}
 *
 * @example
 *   {
 *     ops: [
 *       { insert: 'Gandalf', attributes: { bold: true } },
 *       { insert: ' the ' },
 *       { insert: 'Grey', attributes: { color: '#cccccc' } }
 *     ]
 *   }
 *
 */

/**
  * Attributes that can be assigned to a selection of text.
  *
  * @example
  *   {
  *     bold: true,
  *     font-size: '40px'
  *   }
  *
  * @typedef {Object} TextAttributes
  */

/**
 * @extends YEvent<YText>
 * Event that describes the changes on a YText type.
 */
class YTextEvent extends YEvent {
  /**
   * @param {YText} ytext
   * @param {Transaction} transaction
   * @param {Set<any>} subs The keys that changed
   */
  constructor (ytext, transaction, subs) {
    super(ytext, transaction);
    /**
     * Whether the children changed.
     * @type {Boolean}
     * @private
     */
    this.childListChanged = false;
    /**
     * Set of all changed attributes.
     * @type {Set<string>}
     */
    this.keysChanged = new Set();
    subs.forEach((sub) => {
      if (sub === null) {
        this.childListChanged = true;
      } else {
        this.keysChanged.add(sub);
      }
    });
  }

  /**
   * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
   */
  get changes () {
    if (this._changes === null) {
      /**
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string|AbstractType<any>|object, delete?:number, retain?:number}>}}
       */
      const changes = {
        keys: this.keys,
        delta: this.delta,
        added: new Set(),
        deleted: new Set()
      };
      this._changes = changes;
    }
    return /** @type {any} */ (this._changes)
  }

  /**
   * Compute the changes in the delta format.
   * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
   *
   * @type {Array<{insert?:string|object|AbstractType<any>, delete?:number, retain?:number, attributes?: Object<string,any>}>}
   *
   * @public
   */
  get delta () {
    if (this._delta === null) {
      const y = /** @type {Doc} */ (this.target.doc);
      /**
       * @type {Array<{insert?:string|object|AbstractType<any>, delete?:number, retain?:number, attributes?: Object<string,any>}>}
       */
      const delta = [];
      transact(y, transaction => {
        const currentAttributes = new Map(); // saves all current attributes for insert
        const oldAttributes = new Map();
        let item = this.target._start;
        /**
         * @type {string?}
         */
        let action = null;
        /**
         * @type {Object<string,any>}
         */
        const attributes = {}; // counts added or removed new attributes for retain
        /**
         * @type {string|object}
         */
        let insert = '';
        let retain = 0;
        let deleteLen = 0;
        const addOp = () => {
          if (action !== null) {
            /**
             * @type {any}
             */
            let op = null;
            switch (action) {
              case 'delete':
                if (deleteLen > 0) {
                  op = { delete: deleteLen };
                }
                deleteLen = 0;
                break
              case 'insert':
                if (typeof insert === 'object' || insert.length > 0) {
                  op = { insert };
                  if (currentAttributes.size > 0) {
                    op.attributes = {};
                    currentAttributes.forEach((value, key) => {
                      if (value !== null) {
                        op.attributes[key] = value;
                      }
                    });
                  }
                }
                insert = '';
                break
              case 'retain':
                if (retain > 0) {
                  op = { retain };
                  if (!object__namespace.isEmpty(attributes)) {
                    op.attributes = object__namespace.assign({}, attributes);
                  }
                }
                retain = 0;
                break
            }
            if (op) delta.push(op);
            action = null;
          }
        };
        while (item !== null) {
          switch (item.content.constructor) {
            case ContentType:
            case ContentEmbed:
              if (this.adds(item)) {
                if (!this.deletes(item)) {
                  addOp();
                  action = 'insert';
                  insert = item.content.getContent()[0];
                  addOp();
                }
              } else if (this.deletes(item)) {
                if (action !== 'delete') {
                  addOp();
                  action = 'delete';
                }
                deleteLen += 1;
              } else if (!item.deleted) {
                if (action !== 'retain') {
                  addOp();
                  action = 'retain';
                }
                retain += 1;
              }
              break
            case ContentString:
              if (this.adds(item)) {
                if (!this.deletes(item)) {
                  if (action !== 'insert') {
                    addOp();
                    action = 'insert';
                  }
                  insert += /** @type {ContentString} */ (item.content).str;
                }
              } else if (this.deletes(item)) {
                if (action !== 'delete') {
                  addOp();
                  action = 'delete';
                }
                deleteLen += item.length;
              } else if (!item.deleted) {
                if (action !== 'retain') {
                  addOp();
                  action = 'retain';
                }
                retain += item.length;
              }
              break
            case ContentFormat: {
              const { key, value } = /** @type {ContentFormat} */ (item.content);
              if (this.adds(item)) {
                if (!this.deletes(item)) {
                  const curVal = currentAttributes.get(key) ?? null;
                  if (!equalAttrs(curVal, value)) {
                    if (action === 'retain') {
                      addOp();
                    }
                    if (equalAttrs(value, (oldAttributes.get(key) ?? null))) {
                      delete attributes[key];
                    } else {
                      attributes[key] = value;
                    }
                  } else if (value !== null) {
                    item.delete(transaction);
                  }
                }
              } else if (this.deletes(item)) {
                oldAttributes.set(key, value);
                const curVal = currentAttributes.get(key) ?? null;
                if (!equalAttrs(curVal, value)) {
                  if (action === 'retain') {
                    addOp();
                  }
                  attributes[key] = curVal;
                }
              } else if (!item.deleted) {
                oldAttributes.set(key, value);
                const attr = attributes[key];
                if (attr !== undefined) {
                  if (!equalAttrs(attr, value)) {
                    if (action === 'retain') {
                      addOp();
                    }
                    if (value === null) {
                      delete attributes[key];
                    } else {
                      attributes[key] = value;
                    }
                  } else if (attr !== null) { // this will be cleaned up automatically by the contextless cleanup function
                    item.delete(transaction);
                  }
                }
              }
              if (!item.deleted) {
                if (action === 'insert') {
                  addOp();
                }
                updateCurrentAttributes(currentAttributes, /** @type {ContentFormat} */ (item.content));
              }
              break
            }
          }
          item = item.right;
        }
        addOp();
        while (delta.length > 0) {
          const lastOp = delta[delta.length - 1];
          if (lastOp.retain !== undefined && lastOp.attributes === undefined) {
            // retain delta's if they don't assign attributes
            delta.pop();
          } else {
            break
          }
        }
      });
      this._delta = delta;
    }
    return /** @type {any} */ (this._delta)
  }
}

/**
 * Type that represents text with formatting information.
 *
 * This type replaces y-richtext as this implementation is able to handle
 * block formats (format information on a paragraph), embeds (complex elements
 * like pictures and videos), and text formats (**bold**, *italic*).
 *
 * @extends AbstractType<YTextEvent>
 */
class YText extends AbstractType {
  /**
   * @param {String} [string] The initial value of the YText.
   */
  constructor (string) {
    super();
    /**
     * Array of pending operations on this type
     * @type {Array<function():void>?}
     */
    this._pending = string !== undefined ? [() => this.insert(0, string)] : [];
    /**
     * @type {Array<ArraySearchMarker>|null}
     */
    this._searchMarker = [];
    /**
     * Whether this YText contains formatting attributes.
     * This flag is updated when a formatting item is integrated (see ContentFormat.integrate)
     */
    this._hasFormatting = false;
  }

  /**
   * Number of characters of this text type.
   *
   * @type {number}
   */
  get length () {
    return this._length
  }

  /**
   * @param {Doc} y
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item);
    try {
      /** @type {Array<function>} */ (this._pending).forEach(f => f());
    } catch (e) {
      console.error(e);
    }
    this._pending = null;
  }

  _copy () {
    return new YText()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YText}
   */
  clone () {
    const text = new YText();
    text.applyDelta(this.toDelta());
    return text
  }

  /**
   * Creates YTextEvent and calls observers.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    super._callObserver(transaction, parentSubs);
    const event = new YTextEvent(this, transaction, parentSubs);
    callTypeObservers(this, transaction, event);
    // If a remote change happened, we try to cleanup potential formatting duplicates.
    if (!transaction.local && this._hasFormatting) {
      transaction._needFormattingCleanup = true;
    }
  }

  /**
   * Returns the unformatted string representation of this YText type.
   *
   * @public
   */
  toString () {
    let str = '';
    /**
     * @type {Item|null}
     */
    let n = this._start;
    while (n !== null) {
      if (!n.deleted && n.countable && n.content.constructor === ContentString) {
        str += /** @type {ContentString} */ (n.content).str;
      }
      n = n.right;
    }
    return str
  }

  /**
   * Returns the unformatted string representation of this YText type.
   *
   * @return {string}
   * @public
   */
  toJSON () {
    return this.toString()
  }

  /**
   * Apply a {@link Delta} on this shared YText type.
   *
   * @param {any} delta The changes to apply on this element.
   * @param {object}  opts
   * @param {boolean} [opts.sanitize] Sanitize input delta. Removes ending newlines if set to true.
   *
   *
   * @public
   */
  applyDelta (delta, { sanitize = true } = {}) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        const currPos = new ItemTextListPosition(null, this._start, 0, new Map());
        for (let i = 0; i < delta.length; i++) {
          const op = delta[i];
          if (op.insert !== undefined) {
            // Quill assumes that the content starts with an empty paragraph.
            // Yjs/Y.Text assumes that it starts empty. We always hide that
            // there is a newline at the end of the content.
            // If we omit this step, clients will see a different number of
            // paragraphs, but nothing bad will happen.
            const ins = (!sanitize && typeof op.insert === 'string' && i === delta.length - 1 && currPos.right === null && op.insert.slice(-1) === '\n') ? op.insert.slice(0, -1) : op.insert;
            if (typeof ins !== 'string' || ins.length > 0) {
              insertText(transaction, this, currPos, ins, op.attributes || {});
            }
          } else if (op.retain !== undefined) {
            formatText(transaction, this, currPos, op.retain, op.attributes || {});
          } else if (op.delete !== undefined) {
            deleteText(transaction, currPos, op.delete);
          }
        }
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.applyDelta(delta));
    }
  }

  /**
   * Returns the Delta representation of this YText type.
   *
   * @param {Snapshot} [snapshot]
   * @param {Snapshot} [prevSnapshot]
   * @param {function('removed' | 'added', ID):any} [computeYChange]
   * @return {any} The Delta representation of this type.
   *
   * @public
   */
  toDelta (snapshot, prevSnapshot, computeYChange) {
    /**
     * @type{Array<any>}
     */
    const ops = [];
    const currentAttributes = new Map();
    const doc = /** @type {Doc} */ (this.doc);
    let str = '';
    let n = this._start;
    function packStr () {
      if (str.length > 0) {
        // pack str with attributes to ops
        /**
         * @type {Object<string,any>}
         */
        const attributes = {};
        let addAttributes = false;
        currentAttributes.forEach((value, key) => {
          addAttributes = true;
          attributes[key] = value;
        });
        /**
         * @type {Object<string,any>}
         */
        const op = { insert: str };
        if (addAttributes) {
          op.attributes = attributes;
        }
        ops.push(op);
        str = '';
      }
    }
    const computeDelta = () => {
      while (n !== null) {
        if (isVisible(n, snapshot) || (prevSnapshot !== undefined && isVisible(n, prevSnapshot))) {
          switch (n.content.constructor) {
            case ContentString: {
              const cur = currentAttributes.get('ychange');
              if (snapshot !== undefined && !isVisible(n, snapshot)) {
                if (cur === undefined || cur.user !== n.id.client || cur.type !== 'removed') {
                  packStr();
                  currentAttributes.set('ychange', computeYChange ? computeYChange('removed', n.id) : { type: 'removed' });
                }
              } else if (prevSnapshot !== undefined && !isVisible(n, prevSnapshot)) {
                if (cur === undefined || cur.user !== n.id.client || cur.type !== 'added') {
                  packStr();
                  currentAttributes.set('ychange', computeYChange ? computeYChange('added', n.id) : { type: 'added' });
                }
              } else if (cur !== undefined) {
                packStr();
                currentAttributes.delete('ychange');
              }
              str += /** @type {ContentString} */ (n.content).str;
              break
            }
            case ContentType:
            case ContentEmbed: {
              packStr();
              /**
               * @type {Object<string,any>}
               */
              const op = {
                insert: n.content.getContent()[0]
              };
              if (currentAttributes.size > 0) {
                const attrs = /** @type {Object<string,any>} */ ({});
                op.attributes = attrs;
                currentAttributes.forEach((value, key) => {
                  attrs[key] = value;
                });
              }
              ops.push(op);
              break
            }
            case ContentFormat:
              if (isVisible(n, snapshot)) {
                packStr();
                updateCurrentAttributes(currentAttributes, /** @type {ContentFormat} */ (n.content));
              }
              break
          }
        }
        n = n.right;
      }
      packStr();
    };
    if (snapshot || prevSnapshot) {
      // snapshots are merged again after the transaction, so we need to keep the
      // transaction alive until we are done
      transact(doc, transaction => {
        if (snapshot) {
          splitSnapshotAffectedStructs(transaction, snapshot);
        }
        if (prevSnapshot) {
          splitSnapshotAffectedStructs(transaction, prevSnapshot);
        }
        computeDelta();
      }, 'cleanup');
    } else {
      computeDelta();
    }
    return ops
  }

  /**
   * Insert text at a given index.
   *
   * @param {number} index The index at which to start inserting.
   * @param {String} text The text to insert at the specified position.
   * @param {TextAttributes} [attributes] Optionally define some formatting
   *                                    information to apply on the inserted
   *                                    Text.
   * @public
   */
  insert (index, text, attributes) {
    if (text.length <= 0) {
      return
    }
    const y = this.doc;
    if (y !== null) {
      transact(y, transaction => {
        const pos = findPosition(transaction, this, index, !attributes);
        if (!attributes) {
          attributes = {};
          // @ts-ignore
          pos.currentAttributes.forEach((v, k) => { attributes[k] = v; });
        }
        insertText(transaction, this, pos, text, attributes);
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.insert(index, text, attributes));
    }
  }

  /**
   * Inserts an embed at a index.
   *
   * @param {number} index The index to insert the embed at.
   * @param {Object | AbstractType<any>} embed The Object that represents the embed.
   * @param {TextAttributes} [attributes] Attribute information to apply on the
   *                                    embed
   *
   * @public
   */
  insertEmbed (index, embed, attributes) {
    const y = this.doc;
    if (y !== null) {
      transact(y, transaction => {
        const pos = findPosition(transaction, this, index, !attributes);
        insertText(transaction, this, pos, embed, attributes || {});
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.insertEmbed(index, embed, attributes || {}));
    }
  }

  /**
   * Deletes text starting from an index.
   *
   * @param {number} index Index at which to start deleting.
   * @param {number} length The number of characters to remove. Defaults to 1.
   *
   * @public
   */
  delete (index, length) {
    if (length === 0) {
      return
    }
    const y = this.doc;
    if (y !== null) {
      transact(y, transaction => {
        deleteText(transaction, findPosition(transaction, this, index, true), length);
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.delete(index, length));
    }
  }

  /**
   * Assigns properties to a range of text.
   *
   * @param {number} index The position where to start formatting.
   * @param {number} length The amount of characters to assign properties to.
   * @param {TextAttributes} attributes Attribute information to apply on the
   *                                    text.
   *
   * @public
   */
  format (index, length, attributes) {
    if (length === 0) {
      return
    }
    const y = this.doc;
    if (y !== null) {
      transact(y, transaction => {
        const pos = findPosition(transaction, this, index, false);
        if (pos.right === null) {
          return
        }
        formatText(transaction, this, pos, length, attributes);
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.format(index, length, attributes));
    }
  }

  /**
   * Removes an attribute.
   *
   * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
   *
   * @param {String} attributeName The attribute name that is to be removed.
   *
   * @public
   */
  removeAttribute (attributeName) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapDelete(transaction, this, attributeName);
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.removeAttribute(attributeName));
    }
  }

  /**
   * Sets or updates an attribute.
   *
   * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
   *
   * @param {String} attributeName The attribute name that is to be set.
   * @param {any} attributeValue The attribute value that is to be set.
   *
   * @public
   */
  setAttribute (attributeName, attributeValue) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapSet(transaction, this, attributeName, attributeValue);
      });
    } else {
      /** @type {Array<function>} */ (this._pending).push(() => this.setAttribute(attributeName, attributeValue));
    }
  }

  /**
   * Returns an attribute value that belongs to the attribute name.
   *
   * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
   *
   * @param {String} attributeName The attribute name that identifies the
   *                               queried value.
   * @return {any} The queried attribute value.
   *
   * @public
   */
  getAttribute (attributeName) {
    return /** @type {any} */ (typeMapGet(this, attributeName))
  }

  /**
   * Returns all attribute name/value pairs in a JSON Object.
   *
   * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
   *
   * @return {Object<string, any>} A JSON Object that describes the attributes.
   *
   * @public
   */
  getAttributes () {
    return typeMapGetAll(this)
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  _write (encoder) {
    encoder.writeTypeRef(YTextRefID);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} _decoder
 * @return {YText}
 *
 * @private
 * @function
 */
const readYText = _decoder => new YText();

/**
 * @module YXml
 */


/**
 * Define the elements to which a set of CSS queries apply.
 * {@link https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Selectors|CSS_Selectors}
 *
 * @example
 *   query = '.classSelector'
 *   query = 'nodeSelector'
 *   query = '#idSelector'
 *
 * @typedef {string} CSS_Selector
 */

/**
 * Dom filter function.
 *
 * @callback domFilter
 * @param {string} nodeName The nodeName of the element
 * @param {Map} attributes The map of attributes.
 * @return {boolean} Whether to include the Dom node in the YXmlElement.
 */

/**
 * Represents a subset of the nodes of a YXmlElement / YXmlFragment and a
 * position within them.
 *
 * Can be created with {@link YXmlFragment#createTreeWalker}
 *
 * @public
 * @implements {Iterable<YXmlElement|YXmlText|YXmlElement|YXmlHook>}
 */
class YXmlTreeWalker {
  /**
   * @param {YXmlFragment | YXmlElement} root
   * @param {function(AbstractType<any>):boolean} [f]
   */
  constructor (root, f = () => true) {
    this._filter = f;
    this._root = root;
    /**
     * @type {Item}
     */
    this._currentNode = /** @type {Item} */ (root._start);
    this._firstCall = true;
  }

  [Symbol.iterator] () {
    return this
  }

  /**
   * Get the next node.
   *
   * @return {IteratorResult<YXmlElement|YXmlText|YXmlHook>} The next node.
   *
   * @public
   */
  next () {
    /**
     * @type {Item|null}
     */
    let n = this._currentNode;
    let type = n && n.content && /** @type {any} */ (n.content).type;
    if (n !== null && (!this._firstCall || n.deleted || !this._filter(type))) { // if first call, we check if we can use the first item
      do {
        type = /** @type {any} */ (n.content).type;
        if (!n.deleted && (type.constructor === YXmlElement || type.constructor === YXmlFragment) && type._start !== null) {
          // walk down in the tree
          n = type._start;
        } else {
          // walk right or up in the tree
          while (n !== null) {
            if (n.right !== null) {
              n = n.right;
              break
            } else if (n.parent === this._root) {
              n = null;
            } else {
              n = /** @type {AbstractType<any>} */ (n.parent)._item;
            }
          }
        }
      } while (n !== null && (n.deleted || !this._filter(/** @type {ContentType} */ (n.content).type)))
    }
    this._firstCall = false;
    if (n === null) {
      // @ts-ignore
      return { value: undefined, done: true }
    }
    this._currentNode = n;
    return { value: /** @type {any} */ (n.content).type, done: false }
  }
}

/**
 * Represents a list of {@link YXmlElement}.and {@link YXmlText} types.
 * A YxmlFragment is similar to a {@link YXmlElement}, but it does not have a
 * nodeName and it does not have attributes. Though it can be bound to a DOM
 * element - in this case the attributes and the nodeName are not shared.
 *
 * @public
 * @extends AbstractType<YXmlEvent>
 */
class YXmlFragment extends AbstractType {
  constructor () {
    super();
    /**
     * @type {Array<any>|null}
     */
    this._prelimContent = [];
  }

  /**
   * @type {YXmlElement|YXmlText|null}
   */
  get firstChild () {
    const first = this._first;
    return first ? first.content.getContent()[0] : null
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item);
    this.insert(0, /** @type {Array<any>} */ (this._prelimContent));
    this._prelimContent = null;
  }

  _copy () {
    return new YXmlFragment()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YXmlFragment}
   */
  clone () {
    const el = new YXmlFragment();
    // @ts-ignore
    el.insert(0, this.toArray().map(item => item instanceof AbstractType ? item.clone() : item));
    return el
  }

  get length () {
    return this._prelimContent === null ? this._length : this._prelimContent.length
  }

  /**
   * Create a subtree of childNodes.
   *
   * @example
   * const walker = elem.createTreeWalker(dom => dom.nodeName === 'div')
   * for (let node in walker) {
   *   // `node` is a div node
   *   nop(node)
   * }
   *
   * @param {function(AbstractType<any>):boolean} filter Function that is called on each child element and
   *                          returns a Boolean indicating whether the child
   *                          is to be included in the subtree.
   * @return {YXmlTreeWalker} A subtree and a position within it.
   *
   * @public
   */
  createTreeWalker (filter) {
    return new YXmlTreeWalker(this, filter)
  }

  /**
   * Returns the first YXmlElement that matches the query.
   * Similar to DOM's {@link querySelector}.
   *
   * Query support:
   *   - tagname
   * TODO:
   *   - id
   *   - attribute
   *
   * @param {CSS_Selector} query The query on the children.
   * @return {YXmlElement|YXmlText|YXmlHook|null} The first element that matches the query or null.
   *
   * @public
   */
  querySelector (query) {
    query = query.toUpperCase();
    // @ts-ignore
    const iterator = new YXmlTreeWalker(this, element => element.nodeName && element.nodeName.toUpperCase() === query);
    const next = iterator.next();
    if (next.done) {
      return null
    } else {
      return next.value
    }
  }

  /**
   * Returns all YXmlElements that match the query.
   * Similar to Dom's {@link querySelectorAll}.
   *
   * @todo Does not yet support all queries. Currently only query by tagName.
   *
   * @param {CSS_Selector} query The query on the children
   * @return {Array<YXmlElement|YXmlText|YXmlHook|null>} The elements that match this query.
   *
   * @public
   */
  querySelectorAll (query) {
    query = query.toUpperCase();
    // @ts-ignore
    return array__namespace.from(new YXmlTreeWalker(this, element => element.nodeName && element.nodeName.toUpperCase() === query))
  }

  /**
   * Creates YXmlEvent and calls observers.
   *
   * @param {Transaction} transaction
   * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
   */
  _callObserver (transaction, parentSubs) {
    callTypeObservers(this, transaction, new YXmlEvent(this, parentSubs, transaction));
  }

  /**
   * Get the string representation of all the children of this YXmlFragment.
   *
   * @return {string} The string representation of all children.
   */
  toString () {
    return typeListMap(this, xml => xml.toString()).join('')
  }

  /**
   * @return {string}
   */
  toJSON () {
    return this.toString()
  }

  /**
   * Creates a Dom Element that mirrors this YXmlElement.
   *
   * @param {Document} [_document=document] The document object (you must define
   *                                        this when calling this method in
   *                                        nodejs)
   * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
   *                                             are presented in the DOM
   * @param {any} [binding] You should not set this property. This is
   *                               used if DomBinding wants to create a
   *                               association to the created DOM type.
   * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
   *
   * @public
   */
  toDOM (_document = document, hooks = {}, binding) {
    const fragment = _document.createDocumentFragment();
    if (binding !== undefined) {
      binding._createAssociation(fragment, this);
    }
    typeListForEach(this, xmlType => {
      fragment.insertBefore(xmlType.toDOM(_document, hooks, binding), null);
    });
    return fragment
  }

  /**
   * Inserts new content at an index.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  xml.insert(0, [new Y.XmlText('text')])
   *
   * @param {number} index The index to insert content at
   * @param {Array<YXmlElement|YXmlText>} content The array of content
   */
  insert (index, content) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListInsertGenerics(transaction, this, index, content);
      });
    } else {
      // @ts-ignore _prelimContent is defined because this is not yet integrated
      this._prelimContent.splice(index, 0, ...content);
    }
  }

  /**
   * Inserts new content at an index.
   *
   * @example
   *  // Insert character 'a' at position 0
   *  xml.insert(0, [new Y.XmlText('text')])
   *
   * @param {null|Item|YXmlElement|YXmlText} ref The index to insert content at
   * @param {Array<YXmlElement|YXmlText>} content The array of content
   */
  insertAfter (ref, content) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        const refItem = (ref && ref instanceof AbstractType) ? ref._item : ref;
        typeListInsertGenericsAfter(transaction, this, refItem, content);
      });
    } else {
      const pc = /** @type {Array<any>} */ (this._prelimContent);
      const index = ref === null ? 0 : pc.findIndex(el => el === ref) + 1;
      if (index === 0 && ref !== null) {
        throw error__namespace.create('Reference item not found')
      }
      pc.splice(index, 0, ...content);
    }
  }

  /**
   * Deletes elements starting from an index.
   *
   * @param {number} index Index at which to start deleting elements
   * @param {number} [length=1] The number of elements to remove. Defaults to 1.
   */
  delete (index, length = 1) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeListDelete(transaction, this, index, length);
      });
    } else {
      // @ts-ignore _prelimContent is defined because this is not yet integrated
      this._prelimContent.splice(index, length);
    }
  }

  /**
   * Transforms this YArray to a JavaScript Array.
   *
   * @return {Array<YXmlElement|YXmlText|YXmlHook>}
   */
  toArray () {
    return typeListToArray(this)
  }

  /**
   * Appends content to this YArray.
   *
   * @param {Array<YXmlElement|YXmlText>} content Array of content to append.
   */
  push (content) {
    this.insert(this.length, content);
  }

  /**
   * Prepends content to this YArray.
   *
   * @param {Array<YXmlElement|YXmlText>} content Array of content to prepend.
   */
  unshift (content) {
    this.insert(0, content);
  }

  /**
   * Returns the i-th element from a YArray.
   *
   * @param {number} index The index of the element to return from the YArray
   * @return {YXmlElement|YXmlText}
   */
  get (index) {
    return typeListGet(this, index)
  }

  /**
   * Returns a portion of this YXmlFragment into a JavaScript Array selected
   * from start to end (end not included).
   *
   * @param {number} [start]
   * @param {number} [end]
   * @return {Array<YXmlElement|YXmlText>}
   */
  slice (start = 0, end = this.length) {
    return typeListSlice(this, start, end)
  }

  /**
   * Executes a provided function on once on every child element.
   *
   * @param {function(YXmlElement|YXmlText,number, typeof self):void} f A function to execute on every element of this YArray.
   */
  forEach (f) {
    typeListForEach(this, f);
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   */
  _write (encoder) {
    encoder.writeTypeRef(YXmlFragmentRefID);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} _decoder
 * @return {YXmlFragment}
 *
 * @private
 * @function
 */
const readYXmlFragment = _decoder => new YXmlFragment();

/**
 * @typedef {Object|number|null|Array<any>|string|Uint8Array|AbstractType<any>} ValueTypes
 */

/**
 * An YXmlElement imitates the behavior of a
 * https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element
 *
 * * An YXmlElement has attributes (key value pairs)
 * * An YXmlElement has childElements that must inherit from YXmlElement
 *
 * @template {{ [key: string]: ValueTypes }} [KV={ [key: string]: string }]
 */
class YXmlElement extends YXmlFragment {
  constructor (nodeName = 'UNDEFINED') {
    super();
    this.nodeName = nodeName;
    /**
     * @type {Map<string, any>|null}
     */
    this._prelimAttrs = new Map();
  }

  /**
   * @type {YXmlElement|YXmlText|null}
   */
  get nextSibling () {
    const n = this._item ? this._item.next : null;
    return n ? /** @type {YXmlElement|YXmlText} */ (/** @type {ContentType} */ (n.content).type) : null
  }

  /**
   * @type {YXmlElement|YXmlText|null}
   */
  get prevSibling () {
    const n = this._item ? this._item.prev : null;
    return n ? /** @type {YXmlElement|YXmlText} */ (/** @type {ContentType} */ (n.content).type) : null
  }

  /**
   * Integrate this type into the Yjs instance.
   *
   * * Save this struct in the os
   * * This type is sent to other client
   * * Observer functions are fired
   *
   * @param {Doc} y The Yjs instance
   * @param {Item} item
   */
  _integrate (y, item) {
    super._integrate(y, item)
    ;(/** @type {Map<string, any>} */ (this._prelimAttrs)).forEach((value, key) => {
      this.setAttribute(key, value);
    });
    this._prelimAttrs = null;
  }

  /**
   * Creates an Item with the same effect as this Item (without position effect)
   *
   * @return {YXmlElement}
   */
  _copy () {
    return new YXmlElement(this.nodeName)
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YXmlElement<KV>}
   */
  clone () {
    /**
     * @type {YXmlElement<KV>}
     */
    const el = new YXmlElement(this.nodeName);
    const attrs = this.getAttributes();
    object__namespace.forEach(attrs, (value, key) => {
      if (typeof value === 'string') {
        el.setAttribute(key, value);
      }
    });
    // @ts-ignore
    el.insert(0, this.toArray().map(item => item instanceof AbstractType ? item.clone() : item));
    return el
  }

  /**
   * Returns the XML serialization of this YXmlElement.
   * The attributes are ordered by attribute-name, so you can easily use this
   * method to compare YXmlElements
   *
   * @return {string} The string representation of this type.
   *
   * @public
   */
  toString () {
    const attrs = this.getAttributes();
    const stringBuilder = [];
    const keys = [];
    for (const key in attrs) {
      keys.push(key);
    }
    keys.sort();
    const keysLen = keys.length;
    for (let i = 0; i < keysLen; i++) {
      const key = keys[i];
      stringBuilder.push(key + '="' + attrs[key] + '"');
    }
    const nodeName = this.nodeName.toLocaleLowerCase();
    const attrsString = stringBuilder.length > 0 ? ' ' + stringBuilder.join(' ') : '';
    return `<${nodeName}${attrsString}>${super.toString()}</${nodeName}>`
  }

  /**
   * Removes an attribute from this YXmlElement.
   *
   * @param {string} attributeName The attribute name that is to be removed.
   *
   * @public
   */
  removeAttribute (attributeName) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapDelete(transaction, this, attributeName);
      });
    } else {
      /** @type {Map<string,any>} */ (this._prelimAttrs).delete(attributeName);
    }
  }

  /**
   * Sets or updates an attribute.
   *
   * @template {keyof KV & string} KEY
   *
   * @param {KEY} attributeName The attribute name that is to be set.
   * @param {KV[KEY]} attributeValue The attribute value that is to be set.
   *
   * @public
   */
  setAttribute (attributeName, attributeValue) {
    if (this.doc !== null) {
      transact(this.doc, transaction => {
        typeMapSet(transaction, this, attributeName, attributeValue);
      });
    } else {
      /** @type {Map<string, any>} */ (this._prelimAttrs).set(attributeName, attributeValue);
    }
  }

  /**
   * Returns an attribute value that belongs to the attribute name.
   *
   * @template {keyof KV & string} KEY
   *
   * @param {KEY} attributeName The attribute name that identifies the
   *                               queried value.
   * @return {KV[KEY]|undefined} The queried attribute value.
   *
   * @public
   */
  getAttribute (attributeName) {
    return /** @type {any} */ (typeMapGet(this, attributeName))
  }

  /**
   * Returns whether an attribute exists
   *
   * @param {string} attributeName The attribute name to check for existence.
   * @return {boolean} whether the attribute exists.
   *
   * @public
   */
  hasAttribute (attributeName) {
    return /** @type {any} */ (typeMapHas(this, attributeName))
  }

  /**
   * Returns all attribute name/value pairs in a JSON Object.
   *
   * @param {Snapshot} [snapshot]
   * @return {{ [Key in Extract<keyof KV,string>]?: KV[Key]}} A JSON Object that describes the attributes.
   *
   * @public
   */
  getAttributes (snapshot) {
    return /** @type {any} */ (snapshot ? typeMapGetAllSnapshot(this, snapshot) : typeMapGetAll(this))
  }

  /**
   * Creates a Dom Element that mirrors this YXmlElement.
   *
   * @param {Document} [_document=document] The document object (you must define
   *                                        this when calling this method in
   *                                        nodejs)
   * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
   *                                             are presented in the DOM
   * @param {any} [binding] You should not set this property. This is
   *                               used if DomBinding wants to create a
   *                               association to the created DOM type.
   * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
   *
   * @public
   */
  toDOM (_document = document, hooks = {}, binding) {
    const dom = _document.createElement(this.nodeName);
    const attrs = this.getAttributes();
    for (const key in attrs) {
      const value = attrs[key];
      if (typeof value === 'string') {
        dom.setAttribute(key, value);
      }
    }
    typeListForEach(this, yxml => {
      dom.appendChild(yxml.toDOM(_document, hooks, binding));
    });
    if (binding !== undefined) {
      binding._createAssociation(dom, this);
    }
    return dom
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   */
  _write (encoder) {
    encoder.writeTypeRef(YXmlElementRefID);
    encoder.writeKey(this.nodeName);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {YXmlElement}
 *
 * @function
 */
const readYXmlElement = decoder => new YXmlElement(decoder.readKey());

/**
 * @extends YEvent<YXmlElement|YXmlText|YXmlFragment>
 * An Event that describes changes on a YXml Element or Yxml Fragment
 */
class YXmlEvent extends YEvent {
  /**
   * @param {YXmlElement|YXmlText|YXmlFragment} target The target on which the event is created.
   * @param {Set<string|null>} subs The set of changed attributes. `null` is included if the
   *                   child list changed.
   * @param {Transaction} transaction The transaction instance with wich the
   *                                  change was created.
   */
  constructor (target, subs, transaction) {
    super(target, transaction);
    /**
     * Whether the children changed.
     * @type {Boolean}
     * @private
     */
    this.childListChanged = false;
    /**
     * Set of all changed attributes.
     * @type {Set<string>}
     */
    this.attributesChanged = new Set();
    subs.forEach((sub) => {
      if (sub === null) {
        this.childListChanged = true;
      } else {
        this.attributesChanged.add(sub);
      }
    });
  }
}

/**
 * You can manage binding to a custom type with YXmlHook.
 *
 * @extends {YMap<any>}
 */
class YXmlHook extends YMap {
  /**
   * @param {string} hookName nodeName of the Dom Node.
   */
  constructor (hookName) {
    super();
    /**
     * @type {string}
     */
    this.hookName = hookName;
  }

  /**
   * Creates an Item with the same effect as this Item (without position effect)
   */
  _copy () {
    return new YXmlHook(this.hookName)
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YXmlHook}
   */
  clone () {
    const el = new YXmlHook(this.hookName);
    this.forEach((value, key) => {
      el.set(key, value);
    });
    return el
  }

  /**
   * Creates a Dom Element that mirrors this YXmlElement.
   *
   * @param {Document} [_document=document] The document object (you must define
   *                                        this when calling this method in
   *                                        nodejs)
   * @param {Object.<string, any>} [hooks] Optional property to customize how hooks
   *                                             are presented in the DOM
   * @param {any} [binding] You should not set this property. This is
   *                               used if DomBinding wants to create a
   *                               association to the created DOM type
   * @return {Element} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
   *
   * @public
   */
  toDOM (_document = document, hooks = {}, binding) {
    const hook = hooks[this.hookName];
    let dom;
    if (hook !== undefined) {
      dom = hook.createDom(this);
    } else {
      dom = document.createElement(this.hookName);
    }
    dom.setAttribute('data-yjs-hook', this.hookName);
    if (binding !== undefined) {
      binding._createAssociation(dom, this);
    }
    return dom
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   */
  _write (encoder) {
    encoder.writeTypeRef(YXmlHookRefID);
    encoder.writeKey(this.hookName);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {YXmlHook}
 *
 * @private
 * @function
 */
const readYXmlHook = decoder =>
  new YXmlHook(decoder.readKey());

/**
 * Represents text in a Dom Element. In the future this type will also handle
 * simple formatting information like bold and italic.
 */
class YXmlText extends YText {
  /**
   * @type {YXmlElement|YXmlText|null}
   */
  get nextSibling () {
    const n = this._item ? this._item.next : null;
    return n ? /** @type {YXmlElement|YXmlText} */ (/** @type {ContentType} */ (n.content).type) : null
  }

  /**
   * @type {YXmlElement|YXmlText|null}
   */
  get prevSibling () {
    const n = this._item ? this._item.prev : null;
    return n ? /** @type {YXmlElement|YXmlText} */ (/** @type {ContentType} */ (n.content).type) : null
  }

  _copy () {
    return new YXmlText()
  }

  /**
   * Makes a copy of this data type that can be included somewhere else.
   *
   * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
   *
   * @return {YXmlText}
   */
  clone () {
    const text = new YXmlText();
    text.applyDelta(this.toDelta());
    return text
  }

  /**
   * Creates a Dom Element that mirrors this YXmlText.
   *
   * @param {Document} [_document=document] The document object (you must define
   *                                        this when calling this method in
   *                                        nodejs)
   * @param {Object<string, any>} [hooks] Optional property to customize how hooks
   *                                             are presented in the DOM
   * @param {any} [binding] You should not set this property. This is
   *                               used if DomBinding wants to create a
   *                               association to the created DOM type.
   * @return {Text} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
   *
   * @public
   */
  toDOM (_document = document, hooks, binding) {
    const dom = _document.createTextNode(this.toString());
    if (binding !== undefined) {
      binding._createAssociation(dom, this);
    }
    return dom
  }

  toString () {
    // @ts-ignore
    return this.toDelta().map(delta => {
      const nestedNodes = [];
      for (const nodeName in delta.attributes) {
        const attrs = [];
        for (const key in delta.attributes[nodeName]) {
          attrs.push({ key, value: delta.attributes[nodeName][key] });
        }
        // sort attributes to get a unique order
        attrs.sort((a, b) => a.key < b.key ? -1 : 1);
        nestedNodes.push({ nodeName, attrs });
      }
      // sort node order to get a unique order
      nestedNodes.sort((a, b) => a.nodeName < b.nodeName ? -1 : 1);
      // now convert to dom string
      let str = '';
      for (let i = 0; i < nestedNodes.length; i++) {
        const node = nestedNodes[i];
        str += `<${node.nodeName}`;
        for (let j = 0; j < node.attrs.length; j++) {
          const attr = node.attrs[j];
          str += ` ${attr.key}="${attr.value}"`;
        }
        str += '>';
      }
      str += delta.insert;
      for (let i = nestedNodes.length - 1; i >= 0; i--) {
        str += `</${nestedNodes[i].nodeName}>`;
      }
      return str
    }).join('')
  }

  /**
   * @return {string}
   */
  toJSON () {
    return this.toString()
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  _write (encoder) {
    encoder.writeTypeRef(YXmlTextRefID);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {YXmlText}
 *
 * @private
 * @function
 */
const readYXmlText = decoder => new YXmlText();

class AbstractStruct {
  /**
   * @param {ID} id
   * @param {number} length
   */
  constructor (id, length) {
    this.id = id;
    this.length = length;
  }

  /**
   * @type {boolean}
   */
  get deleted () {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * Merge this struct with the item to the right.
   * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
   * Also this method does *not* remove right from StructStore!
   * @param {AbstractStruct} right
   * @return {boolean} wether this merged with right
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   * @param {number} offset
   * @param {number} encodingRef
   */
  write (encoder, offset, encodingRef) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    throw error__namespace.methodUnimplemented()
  }
}

const structGCRefNumber = 0;

/**
 * @private
 */
class GC extends AbstractStruct {
  get deleted () {
    return true
  }

  delete () {}

  /**
   * @param {GC} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (this.constructor !== right.constructor) {
      return false
    }
    this.length += right.length;
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset;
      this.length -= offset;
    }
    addStruct(transaction.doc.store, this);
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeInfo(structGCRefNumber);
    encoder.writeLen(this.length - offset);
  }

  /**
   * @param {Transaction} transaction
   * @param {StructStore} store
   * @return {null | number}
   */
  getMissing (transaction, store) {
    return null
  }
}

class ContentBinary {
  /**
   * @param {Uint8Array} content
   */
  constructor (content) {
    this.content = content;
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.content]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentBinary}
   */
  copy () {
    return new ContentBinary(this.content)
  }

  /**
   * @param {number} offset
   * @return {ContentBinary}
   */
  splice (offset) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {ContentBinary} right
   * @return {boolean}
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeBuf(this.content);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 3
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2 } decoder
 * @return {ContentBinary}
 */
const readContentBinary = decoder => new ContentBinary(decoder.readBuf());

class ContentDeleted {
  /**
   * @param {number} len
   */
  constructor (len) {
    this.len = len;
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.len
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentDeleted}
   */
  copy () {
    return new ContentDeleted(this.len)
  }

  /**
   * @param {number} offset
   * @return {ContentDeleted}
   */
  splice (offset) {
    const right = new ContentDeleted(this.len - offset);
    this.len = offset;
    return right
  }

  /**
   * @param {ContentDeleted} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.len += right.len;
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    addToDeleteSet(transaction.deleteSet, item.id.client, item.id.clock, this.len);
    item.markDeleted();
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeLen(this.len - offset);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 1
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2 } decoder
 * @return {ContentDeleted}
 */
const readContentDeleted = decoder => new ContentDeleted(decoder.readLen());

/**
 * @param {string} guid
 * @param {Object<string, any>} opts
 */
const createDocFromOpts = (guid, opts) => new Doc({ guid, ...opts, shouldLoad: opts.shouldLoad || opts.autoLoad || false });

/**
 * @private
 */
class ContentDoc {
  /**
   * @param {Doc} doc
   */
  constructor (doc) {
    if (doc._item) {
      console.error('This document was already integrated as a sub-document. You should create a second instance instead with the same guid.');
    }
    /**
     * @type {Doc}
     */
    this.doc = doc;
    /**
     * @type {any}
     */
    const opts = {};
    this.opts = opts;
    if (!doc.gc) {
      opts.gc = false;
    }
    if (doc.autoLoad) {
      opts.autoLoad = true;
    }
    if (doc.meta !== null) {
      opts.meta = doc.meta;
    }
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.doc]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentDoc}
   */
  copy () {
    return new ContentDoc(createDocFromOpts(this.doc.guid, this.opts))
  }

  /**
   * @param {number} offset
   * @return {ContentDoc}
   */
  splice (offset) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {ContentDoc} right
   * @return {boolean}
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    // this needs to be reflected in doc.destroy as well
    this.doc._item = item;
    transaction.subdocsAdded.add(this.doc);
    if (this.doc.shouldLoad) {
      transaction.subdocsLoaded.add(this.doc);
    }
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (transaction.subdocsAdded.has(this.doc)) {
      transaction.subdocsAdded.delete(this.doc);
    } else {
      transaction.subdocsRemoved.add(this.doc);
    }
  }

  /**
   * @param {StructStore} store
   */
  gc (store) { }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeString(this.doc.guid);
    encoder.writeAny(this.opts);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 9
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentDoc}
 */
const readContentDoc = decoder => new ContentDoc(createDocFromOpts(decoder.readString(), decoder.readAny()));

/**
 * @private
 */
class ContentEmbed {
  /**
   * @param {Object} embed
   */
  constructor (embed) {
    this.embed = embed;
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.embed]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentEmbed}
   */
  copy () {
    return new ContentEmbed(this.embed)
  }

  /**
   * @param {number} offset
   * @return {ContentEmbed}
   */
  splice (offset) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {ContentEmbed} right
   * @return {boolean}
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeJSON(this.embed);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 5
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentEmbed}
 */
const readContentEmbed = decoder => new ContentEmbed(decoder.readJSON());

/**
 * @private
 */
class ContentFormat {
  /**
   * @param {string} key
   * @param {Object} value
   */
  constructor (key, value) {
    this.key = key;
    this.value = value;
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return []
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return false
  }

  /**
   * @return {ContentFormat}
   */
  copy () {
    return new ContentFormat(this.key, this.value)
  }

  /**
   * @param {number} _offset
   * @return {ContentFormat}
   */
  splice (_offset) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {ContentFormat} _right
   * @return {boolean}
   */
  mergeWith (_right) {
    return false
  }

  /**
   * @param {Transaction} _transaction
   * @param {Item} item
   */
  integrate (_transaction, item) {
    // @todo searchmarker are currently unsupported for rich text documents
    const p = /** @type {YText} */ (item.parent);
    p._searchMarker = null;
    p._hasFormatting = true;
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeKey(this.key);
    encoder.writeJSON(this.value);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 6
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentFormat}
 */
const readContentFormat = decoder => new ContentFormat(decoder.readKey(), decoder.readJSON());

/**
 * @private
 */
class ContentJSON {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     */
    this.arr = arr;
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentJSON}
   */
  copy () {
    return new ContentJSON(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentJSON}
   */
  splice (offset) {
    const right = new ContentJSON(this.arr.slice(offset));
    this.arr = this.arr.slice(0, offset);
    return right
  }

  /**
   * @param {ContentJSON} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.arr = this.arr.concat(right.arr);
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    const len = this.arr.length;
    encoder.writeLen(len - offset);
    for (let i = offset; i < len; i++) {
      const c = this.arr[i];
      encoder.writeString(c === undefined ? 'undefined' : JSON.stringify(c));
    }
  }

  /**
   * @return {number}
   */
  getRef () {
    return 2
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentJSON}
 */
const readContentJSON = decoder => {
  const len = decoder.readLen();
  const cs = [];
  for (let i = 0; i < len; i++) {
    const c = decoder.readString();
    if (c === 'undefined') {
      cs.push(undefined);
    } else {
      cs.push(JSON.parse(c));
    }
  }
  return new ContentJSON(cs)
};

class ContentAny {
  /**
   * @param {Array<any>} arr
   */
  constructor (arr) {
    /**
     * @type {Array<any>}
     */
    this.arr = arr;
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.arr.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.arr
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentAny}
   */
  copy () {
    return new ContentAny(this.arr)
  }

  /**
   * @param {number} offset
   * @return {ContentAny}
   */
  splice (offset) {
    const right = new ContentAny(this.arr.slice(offset));
    this.arr = this.arr.slice(0, offset);
    return right
  }

  /**
   * @param {ContentAny} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.arr = this.arr.concat(right.arr);
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    const len = this.arr.length;
    encoder.writeLen(len - offset);
    for (let i = offset; i < len; i++) {
      const c = this.arr[i];
      encoder.writeAny(c);
    }
  }

  /**
   * @return {number}
   */
  getRef () {
    return 8
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentAny}
 */
const readContentAny = decoder => {
  const len = decoder.readLen();
  const cs = [];
  for (let i = 0; i < len; i++) {
    cs.push(decoder.readAny());
  }
  return new ContentAny(cs)
};

/**
 * @private
 */
class ContentString {
  /**
   * @param {string} str
   */
  constructor (str) {
    /**
     * @type {string}
     */
    this.str = str;
  }

  /**
   * @return {number}
   */
  getLength () {
    return this.str.length
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return this.str.split('')
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentString}
   */
  copy () {
    return new ContentString(this.str)
  }

  /**
   * @param {number} offset
   * @return {ContentString}
   */
  splice (offset) {
    const right = new ContentString(this.str.slice(offset));
    this.str = this.str.slice(0, offset);

    // Prevent encoding invalid documents because of splitting of surrogate pairs: https://github.com/yjs/yjs/issues/248
    const firstCharCode = this.str.charCodeAt(offset - 1);
    if (firstCharCode >= 0xD800 && firstCharCode <= 0xDBFF) {
      // Last character of the left split is the start of a surrogate utf16/ucs2 pair.
      // We don't support splitting of surrogate pairs because this may lead to invalid documents.
      // Replace the invalid character with a unicode replacement character (� / U+FFFD)
      this.str = this.str.slice(0, offset - 1) + '�';
      // replace right as well
      right.str = '�' + right.str.slice(1);
    }
    return right
  }

  /**
   * @param {ContentString} right
   * @return {boolean}
   */
  mergeWith (right) {
    this.str += right.str;
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {}
  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {}
  /**
   * @param {StructStore} store
   */
  gc (store) {}
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeString(offset === 0 ? this.str : this.str.slice(offset));
  }

  /**
   * @return {number}
   */
  getRef () {
    return 4
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentString}
 */
const readContentString = decoder => new ContentString(decoder.readString());

/**
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractType<any>>}
 * @private
 */
const typeRefs = [
  readYArray,
  readYMap,
  readYText,
  readYXmlElement,
  readYXmlFragment,
  readYXmlHook,
  readYXmlText
];

const YArrayRefID = 0;
const YMapRefID = 1;
const YTextRefID = 2;
const YXmlElementRefID = 3;
const YXmlFragmentRefID = 4;
const YXmlHookRefID = 5;
const YXmlTextRefID = 6;

/**
 * @private
 */
class ContentType {
  /**
   * @param {AbstractType<any>} type
   */
  constructor (type) {
    /**
     * @type {AbstractType<any>}
     */
    this.type = type;
  }

  /**
   * @return {number}
   */
  getLength () {
    return 1
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    return [this.type]
  }

  /**
   * @return {boolean}
   */
  isCountable () {
    return true
  }

  /**
   * @return {ContentType}
   */
  copy () {
    return new ContentType(this.type._copy())
  }

  /**
   * @param {number} offset
   * @return {ContentType}
   */
  splice (offset) {
    throw error__namespace.methodUnimplemented()
  }

  /**
   * @param {ContentType} right
   * @return {boolean}
   */
  mergeWith (right) {
    return false
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    this.type._integrate(transaction.doc, item);
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    let item = this.type._start;
    while (item !== null) {
      if (!item.deleted) {
        item.delete(transaction);
      } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
        // This will be gc'd later and we want to merge it if possible
        // We try to merge all deleted items after each transaction,
        // but we have no knowledge about that this needs to be merged
        // since it is not in transaction.ds. Hence we add it to transaction._mergeStructs
        transaction._mergeStructs.push(item);
      }
      item = item.right;
    }
    this.type._map.forEach(item => {
      if (!item.deleted) {
        item.delete(transaction);
      } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
        // same as above
        transaction._mergeStructs.push(item);
      }
    });
    transaction.changed.delete(this.type);
  }

  /**
   * @param {StructStore} store
   */
  gc (store) {
    let item = this.type._start;
    while (item !== null) {
      item.gc(store, true);
      item = item.right;
    }
    this.type._start = null;
    this.type._map.forEach(/** @param {Item | null} item */ (item) => {
      while (item !== null) {
        item.gc(store, true);
        item = item.left;
      }
    });
    this.type._map = new Map();
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    this.type._write(encoder);
  }

  /**
   * @return {number}
   */
  getRef () {
    return 7
  }
}

/**
 * @private
 *
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @return {ContentType}
 */
const readContentType = decoder => new ContentType(typeRefs[decoder.readTypeRef()](decoder));

/**
 * @todo This should return several items
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {{item:Item, diff:number}}
 */
const followRedone = (store, id) => {
  /**
   * @type {ID|null}
   */
  let nextID = id;
  let diff = 0;
  let item;
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff);
    }
    item = getItem(store, nextID);
    diff = nextID.clock - item.id.clock;
    nextID = item.redone;
  } while (nextID !== null && item instanceof Item)
  return {
    item, diff
  }
};

/**
 * Make sure that neither item nor any of its parents is ever deleted.
 *
 * This property does not persist when storing it into a database or when
 * sending it to other peers
 *
 * @param {Item|null} item
 * @param {boolean} keep
 */
const keepItem = (item, keep) => {
  while (item !== null && item.keep !== keep) {
    item.keep = keep;
    item = /** @type {AbstractType<any>} */ (item.parent)._item;
  }
};

/**
 * Split leftItem into two items
 * @param {Transaction} transaction
 * @param {Item} leftItem
 * @param {number} diff
 * @return {Item}
 *
 * @function
 * @private
 */
const splitItem = (transaction, leftItem, diff) => {
  // create rightItem
  const { client, clock } = leftItem.id;
  const rightItem = new Item(
    createID(client, clock + diff),
    leftItem,
    createID(client, clock + diff - 1),
    leftItem.right,
    leftItem.rightOrigin,
    leftItem.parent,
    leftItem.parentSub,
    leftItem.content.splice(diff)
  );
  if (leftItem.deleted) {
    rightItem.markDeleted();
  }
  if (leftItem.keep) {
    rightItem.keep = true;
  }
  if (leftItem.redone !== null) {
    rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff);
  }
  // update left (do not set leftItem.rightOrigin as it will lead to problems when syncing)
  leftItem.right = rightItem;
  // update right
  if (rightItem.right !== null) {
    rightItem.right.left = rightItem;
  }
  // right is more specific.
  transaction._mergeStructs.push(rightItem);
  // update parent._map
  if (rightItem.parentSub !== null && rightItem.right === null) {
    /** @type {AbstractType<any>} */ (rightItem.parent)._map.set(rightItem.parentSub, rightItem);
  }
  leftItem.length = diff;
  return rightItem
};

/**
 * @param {Array<StackItem>} stack
 * @param {ID} id
 */
const isDeletedByUndoStack = (stack, id) => array__namespace.some(stack, /** @param {StackItem} s */ s => isDeleted(s.deletions, id));

/**
 * Redoes the effect of this operation.
 *
 * @param {Transaction} transaction The Yjs instance.
 * @param {Item} item
 * @param {Set<Item>} redoitems
 * @param {DeleteSet} itemsToDelete
 * @param {boolean} ignoreRemoteMapChanges
 * @param {import('../utils/UndoManager.js').UndoManager} um
 *
 * @return {Item|null}
 *
 * @private
 */
const redoItem = (transaction, item, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) => {
  const doc = transaction.doc;
  const store = doc.store;
  const ownClientID = doc.clientID;
  const redone = item.redone;
  if (redone !== null) {
    return getItemCleanStart(transaction, redone)
  }
  let parentItem = /** @type {AbstractType<any>} */ (item.parent)._item;
  /**
   * @type {Item|null}
   */
  let left = null;
  /**
   * @type {Item|null}
   */
  let right;
  // make sure that parent is redone
  if (parentItem !== null && parentItem.deleted === true) {
    // try to undo parent if it will be undone anyway
    if (parentItem.redone === null && (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems, itemsToDelete, ignoreRemoteMapChanges, um) === null)) {
      return null
    }
    while (parentItem.redone !== null) {
      parentItem = getItemCleanStart(transaction, parentItem.redone);
    }
  }
  const parentType = parentItem === null ? /** @type {AbstractType<any>} */ (item.parent) : /** @type {ContentType} */ (parentItem.content).type;

  if (item.parentSub === null) {
    // Is an array item. Insert at the old position
    left = item.left;
    right = item;
    // find next cloned_redo items
    while (left !== null) {
      /**
       * @type {Item|null}
       */
      let leftTrace = left;
      // trace redone until parent matches
      while (leftTrace !== null && /** @type {AbstractType<any>} */ (leftTrace.parent)._item !== parentItem) {
        leftTrace = leftTrace.redone === null ? null : getItemCleanStart(transaction, leftTrace.redone);
      }
      if (leftTrace !== null && /** @type {AbstractType<any>} */ (leftTrace.parent)._item === parentItem) {
        left = leftTrace;
        break
      }
      left = left.left;
    }
    while (right !== null) {
      /**
       * @type {Item|null}
       */
      let rightTrace = right;
      // trace redone until parent matches
      while (rightTrace !== null && /** @type {AbstractType<any>} */ (rightTrace.parent)._item !== parentItem) {
        rightTrace = rightTrace.redone === null ? null : getItemCleanStart(transaction, rightTrace.redone);
      }
      if (rightTrace !== null && /** @type {AbstractType<any>} */ (rightTrace.parent)._item === parentItem) {
        right = rightTrace;
        break
      }
      right = right.right;
    }
  } else {
    right = null;
    if (item.right && !ignoreRemoteMapChanges) {
      left = item;
      // Iterate right while right is in itemsToDelete
      // If it is intended to delete right while item is redone, we can expect that item should replace right.
      while (left !== null && left.right !== null && (left.right.redone || isDeleted(itemsToDelete, left.right.id) || isDeletedByUndoStack(um.undoStack, left.right.id) || isDeletedByUndoStack(um.redoStack, left.right.id))) {
        left = left.right;
        // follow redone
        while (left.redone) left = getItemCleanStart(transaction, left.redone);
      }
      if (left && left.right !== null) {
        // It is not possible to redo this item because it conflicts with a
        // change from another client
        return null
      }
    } else {
      left = parentType._map.get(item.parentSub) || null;
    }
  }
  const nextClock = getState(store, ownClientID);
  const nextId = createID(ownClientID, nextClock);
  const redoneItem = new Item(
    nextId,
    left, left && left.lastId,
    right, right && right.id,
    parentType,
    item.parentSub,
    item.content.copy()
  );
  item.redone = nextId;
  keepItem(redoneItem, true);
  redoneItem.integrate(transaction, 0);
  return redoneItem
};

/**
 * Abstract class that represents any content.
 */
class Item extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {Item | null} left
   * @param {ID | null} origin
   * @param {Item | null} right
   * @param {ID | null} rightOrigin
   * @param {AbstractType<any>|ID|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it.
   * @param {string | null} parentSub
   * @param {AbstractContent} content
   */
  constructor (id, left, origin, right, rightOrigin, parent, parentSub, content) {
    super(id, content.getLength());
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    this.origin = origin;
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    this.left = left;
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    this.right = right;
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    this.rightOrigin = rightOrigin;
    /**
     * @type {AbstractType<any>|ID|null}
     */
    this.parent = parent;
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     */
    this.parentSub = parentSub;
    /**
     * If this type's effect is redone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    this.redone = null;
    /**
     * @type {AbstractContent}
     */
    this.content = content;
    /**
     * bit1: keep
     * bit2: countable
     * bit3: deleted
     * bit4: mark - mark node as fast-search-marker
     * @type {number} byte
     */
    this.info = this.content.isCountable() ? binary__namespace.BIT2 : 0;
  }

  /**
   * This is used to mark the item as an indexed fast-search marker
   *
   * @type {boolean}
   */
  set marker (isMarked) {
    if (((this.info & binary__namespace.BIT4) > 0) !== isMarked) {
      this.info ^= binary__namespace.BIT4;
    }
  }

  get marker () {
    return (this.info & binary__namespace.BIT4) > 0
  }

  /**
   * If true, do not garbage collect this Item.
   */
  get keep () {
    return (this.info & binary__namespace.BIT1) > 0
  }

  set keep (doKeep) {
    if (this.keep !== doKeep) {
      this.info ^= binary__namespace.BIT1;
    }
  }

  get countable () {
    return (this.info & binary__namespace.BIT2) > 0
  }

  /**
   * Whether this item was deleted or not.
   * @type {Boolean}
   */
  get deleted () {
    return (this.info & binary__namespace.BIT3) > 0
  }

  set deleted (doDelete) {
    if (this.deleted !== doDelete) {
      this.info ^= binary__namespace.BIT3;
    }
  }

  markDeleted () {
    this.info |= binary__namespace.BIT3;
  }

  /**
   * Return the creator clientID of the missing op or define missing items and return null.
   *
   * @param {Transaction} transaction
   * @param {StructStore} store
   * @return {null | number}
   */
  getMissing (transaction, store) {
    if (this.origin && this.origin.client !== this.id.client && this.origin.clock >= getState(store, this.origin.client)) {
      return this.origin.client
    }
    if (this.rightOrigin && this.rightOrigin.client !== this.id.client && this.rightOrigin.clock >= getState(store, this.rightOrigin.client)) {
      return this.rightOrigin.client
    }
    if (this.parent && this.parent.constructor === ID && this.id.client !== this.parent.client && this.parent.clock >= getState(store, this.parent.client)) {
      return this.parent.client
    }

    // We have all missing ids, now find the items

    if (this.origin) {
      this.left = getItemCleanEnd(transaction, store, this.origin);
      this.origin = this.left.lastId;
    }
    if (this.rightOrigin) {
      this.right = getItemCleanStart(transaction, this.rightOrigin);
      this.rightOrigin = this.right.id;
    }
    if ((this.left && this.left.constructor === GC) || (this.right && this.right.constructor === GC)) {
      this.parent = null;
    } else if (!this.parent) {
      // only set parent if this shouldn't be garbage collected
      if (this.left && this.left.constructor === Item) {
        this.parent = this.left.parent;
        this.parentSub = this.left.parentSub;
      }
      if (this.right && this.right.constructor === Item) {
        this.parent = this.right.parent;
        this.parentSub = this.right.parentSub;
      }
    } else if (this.parent.constructor === ID) {
      const parentItem = getItem(store, this.parent);
      if (parentItem.constructor === GC) {
        this.parent = null;
      } else {
        this.parent = /** @type {ContentType} */ (parentItem.content).type;
      }
    }
    return null
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    if (offset > 0) {
      this.id.clock += offset;
      this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1));
      this.origin = this.left.lastId;
      this.content = this.content.splice(offset);
      this.length -= offset;
    }

    if (this.parent) {
      if ((!this.left && (!this.right || this.right.left !== null)) || (this.left && this.left.right !== this.right)) {
        /**
         * @type {Item|null}
         */
        let left = this.left;

        /**
         * @type {Item|null}
         */
        let o;
        // set o to the first conflicting item
        if (left !== null) {
          o = left.right;
        } else if (this.parentSub !== null) {
          o = /** @type {AbstractType<any>} */ (this.parent)._map.get(this.parentSub) || null;
          while (o !== null && o.left !== null) {
            o = o.left;
          }
        } else {
          o = /** @type {AbstractType<any>} */ (this.parent)._start;
        }
        // TODO: use something like DeleteSet here (a tree implementation would be best)
        // @todo use global set definitions
        /**
         * @type {Set<Item>}
         */
        const conflictingItems = new Set();
        /**
         * @type {Set<Item>}
         */
        const itemsBeforeOrigin = new Set();
        // Let c in conflictingItems, b in itemsBeforeOrigin
        // ***{origin}bbbb{this}{c,b}{c,b}{o}***
        // Note that conflictingItems is a subset of itemsBeforeOrigin
        while (o !== null && o !== this.right) {
          itemsBeforeOrigin.add(o);
          conflictingItems.add(o);
          if (compareIDs(this.origin, o.origin)) {
            // case 1
            if (o.id.client < this.id.client) {
              left = o;
              conflictingItems.clear();
            } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
              // this and o are conflicting and point to the same integration points. The id decides which item comes first.
              // Since this is to the left of o, we can break here
              break
            } // else, o might be integrated before an item that this conflicts with. If so, we will find it in the next iterations
          } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) { // use getItem instead of getItemCleanEnd because we don't want / need to split items.
            // case 2
            if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
              left = o;
              conflictingItems.clear();
            }
          } else {
            break
          }
          o = o.right;
        }
        this.left = left;
      }
      // reconnect left/right + update parent map/start if necessary
      if (this.left !== null) {
        const right = this.left.right;
        this.right = right;
        this.left.right = this;
      } else {
        let r;
        if (this.parentSub !== null) {
          r = /** @type {AbstractType<any>} */ (this.parent)._map.get(this.parentSub) || null;
          while (r !== null && r.left !== null) {
            r = r.left;
          }
        } else {
          r = /** @type {AbstractType<any>} */ (this.parent)._start
          ;/** @type {AbstractType<any>} */ (this.parent)._start = this;
        }
        this.right = r;
      }
      if (this.right !== null) {
        this.right.left = this;
      } else if (this.parentSub !== null) {
        // set as current parent value if right === null and this is parentSub
        /** @type {AbstractType<any>} */ (this.parent)._map.set(this.parentSub, this);
        if (this.left !== null) {
          // this is the current attribute value of parent. delete right
          this.left.delete(transaction);
        }
      }
      // adjust length of parent
      if (this.parentSub === null && this.countable && !this.deleted) {
        /** @type {AbstractType<any>} */ (this.parent)._length += this.length;
      }
      addStruct(transaction.doc.store, this);
      this.content.integrate(transaction, this);
      // add parent to transaction.changed
      addChangedTypeToTransaction(transaction, /** @type {AbstractType<any>} */ (this.parent), this.parentSub);
      if ((/** @type {AbstractType<any>} */ (this.parent)._item !== null && /** @type {AbstractType<any>} */ (this.parent)._item.deleted) || (this.parentSub !== null && this.right !== null)) {
        // delete if parent is deleted or if this is not the current attribute value of parent
        this.delete(transaction);
      }
    } else {
      // parent is not defined. Integrate GC struct instead
      new GC(this.id, this.length).integrate(transaction, 0);
    }
  }

  /**
   * Returns the next non-deleted item
   */
  get next () {
    let n = this.right;
    while (n !== null && n.deleted) {
      n = n.right;
    }
    return n
  }

  /**
   * Returns the previous non-deleted item
   */
  get prev () {
    let n = this.left;
    while (n !== null && n.deleted) {
      n = n.left;
    }
    return n
  }

  /**
   * Computes the last content address of this Item.
   */
  get lastId () {
    // allocating ids is pretty costly because of the amount of ids created, so we try to reuse whenever possible
    return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1)
  }

  /**
   * Try to merge two items
   *
   * @param {Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (
      this.constructor === right.constructor &&
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.deleted === right.deleted &&
      this.redone === null &&
      right.redone === null &&
      this.content.constructor === right.content.constructor &&
      this.content.mergeWith(right.content)
    ) {
      const searchMarker = /** @type {AbstractType<any>} */ (this.parent)._searchMarker;
      if (searchMarker) {
        searchMarker.forEach(marker => {
          if (marker.p === right) {
            // right is going to be "forgotten" so we need to update the marker
            marker.p = this;
            // adjust marker index
            if (!this.deleted && this.countable) {
              marker.index -= this.length;
            }
          }
        });
      }
      if (right.keep) {
        this.keep = true;
      }
      this.right = right.right;
      if (this.right !== null) {
        this.right.left = this;
      }
      this.length += right.length;
      return true
    }
    return false
  }

  /**
   * Mark this Item as deleted.
   *
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (!this.deleted) {
      const parent = /** @type {AbstractType<any>} */ (this.parent);
      // adjust the length of parent
      if (this.countable && this.parentSub === null) {
        parent._length -= this.length;
      }
      this.markDeleted();
      addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length);
      addChangedTypeToTransaction(transaction, parent, this.parentSub);
      this.content.delete(transaction);
    }
  }

  /**
   * @param {StructStore} store
   * @param {boolean} parentGCd
   */
  gc (store, parentGCd) {
    if (!this.deleted) {
      throw error__namespace.unexpectedCase()
    }
    this.content.gc(store);
    if (parentGCd) {
      replaceStruct(store, this, new GC(this.id, this.length));
    } else {
      this.content = new ContentDeleted(this.length);
    }
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
   * @param {number} offset
   */
  write (encoder, offset) {
    const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin;
    const rightOrigin = this.rightOrigin;
    const parentSub = this.parentSub;
    const info = (this.content.getRef() & binary__namespace.BITS5) |
      (origin === null ? 0 : binary__namespace.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary__namespace.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary__namespace.BIT6); // parentSub is non-null
    encoder.writeInfo(info);
    if (origin !== null) {
      encoder.writeLeftID(origin);
    }
    if (rightOrigin !== null) {
      encoder.writeRightID(rightOrigin);
    }
    if (origin === null && rightOrigin === null) {
      const parent = /** @type {AbstractType<any>} */ (this.parent);
      if (parent._item !== undefined) {
        const parentItem = parent._item;
        if (parentItem === null) {
          // parent type on y._map
          // find the correct key
          const ykey = findRootTypeKey(parent);
          encoder.writeParentInfo(true); // write parentYKey
          encoder.writeString(ykey);
        } else {
          encoder.writeParentInfo(false); // write parent id
          encoder.writeLeftID(parentItem.id);
        }
      } else if (parent.constructor === String) { // this edge case was added by differential updates
        encoder.writeParentInfo(true); // write parentYKey
        encoder.writeString(parent);
      } else if (parent.constructor === ID) {
        encoder.writeParentInfo(false); // write parent id
        encoder.writeLeftID(parent);
      } else {
        error__namespace.unexpectedCase();
      }
      if (parentSub !== null) {
        encoder.writeString(parentSub);
      }
    }
    this.content.write(encoder, offset);
  }
}

/**
 * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
 * @param {number} info
 */
const readItemContent = (decoder, info) => contentRefs[info & binary__namespace.BITS5](decoder);

/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(UpdateDecoderV1 | UpdateDecoderV2):AbstractContent>}
 */
const contentRefs = [
  () => { error__namespace.unexpectedCase(); }, // GC is not ItemContent
  readContentDeleted, // 1
  readContentJSON, // 2
  readContentBinary, // 3
  readContentString, // 4
  readContentEmbed, // 5
  readContentFormat, // 6
  readContentType, // 7
  readContentAny, // 8
  readContentDoc, // 9
  () => { error__namespace.unexpectedCase(); } // 10 - Skip is not ItemContent
];

const structSkipRefNumber = 10;

/**
 * @private
 */
class Skip extends AbstractStruct {
  get deleted () {
    return true
  }

  delete () {}

  /**
   * @param {Skip} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (this.constructor !== right.constructor) {
      return false
    }
    this.length += right.length;
    return true
  }

  /**
   * @param {Transaction} transaction
   * @param {number} offset
   */
  integrate (transaction, offset) {
    // skip structs cannot be integrated
    error__namespace.unexpectedCase();
  }

  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    encoder.writeInfo(structSkipRefNumber);
    // write as VarUint because Skips can't make use of predictable length-encoding
    encoding__namespace.writeVarUint(encoder.restEncoder, this.length - offset);
  }

  /**
   * @param {Transaction} transaction
   * @param {StructStore} store
   * @return {null | number}
   */
  getMissing (transaction, store) {
    return null
  }
}

/** eslint-env browser */


const glo = /** @type {any} */ (typeof globalThis !== 'undefined'
  ? globalThis
  : typeof window !== 'undefined'
    ? window
    // @ts-ignore
    : typeof global !== 'undefined' ? global : {});

const importIdentifier = '__ $YJS$ __';

if (glo[importIdentifier] === true) {
  /**
   * Dear reader of this message. Please take this seriously.
   *
   * If you see this message, make sure that you only import one version of Yjs. In many cases,
   * your package manager installs two versions of Yjs that are used by different packages within your project.
   * Another reason for this message is that some parts of your project use the commonjs version of Yjs
   * and others use the EcmaScript version of Yjs.
   *
   * This often leads to issues that are hard to debug. We often need to perform constructor checks,
   * e.g. `struct instanceof GC`. If you imported different versions of Yjs, it is impossible for us to
   * do the constructor checks anymore - which might break the CRDT algorithm.
   *
   * https://github.com/yjs/yjs/issues/438
   */
  console.error('Yjs was already imported. This breaks constructor checks and will lead to issues! - https://github.com/yjs/yjs/issues/438');
}
glo[importIdentifier] = true;

var Y$1 = /*#__PURE__*/Object.freeze({
  __proto__: null,
  AbsolutePosition: AbsolutePosition,
  AbstractConnector: AbstractConnector,
  AbstractStruct: AbstractStruct,
  AbstractType: AbstractType,
  Array: YArray,
  ContentAny: ContentAny,
  ContentBinary: ContentBinary,
  ContentDeleted: ContentDeleted,
  ContentDoc: ContentDoc,
  ContentEmbed: ContentEmbed,
  ContentFormat: ContentFormat,
  ContentJSON: ContentJSON,
  ContentString: ContentString,
  ContentType: ContentType,
  Doc: Doc,
  GC: GC,
  ID: ID,
  Item: Item,
  Map: YMap,
  PermanentUserData: PermanentUserData,
  RelativePosition: RelativePosition,
  Skip: Skip,
  Snapshot: Snapshot,
  Text: YText,
  Transaction: Transaction,
  UndoManager: UndoManager,
  UpdateDecoderV1: UpdateDecoderV1,
  UpdateDecoderV2: UpdateDecoderV2,
  UpdateEncoderV1: UpdateEncoderV1,
  UpdateEncoderV2: UpdateEncoderV2,
  XmlElement: YXmlElement,
  XmlFragment: YXmlFragment,
  XmlHook: YXmlHook,
  XmlText: YXmlText,
  YArrayEvent: YArrayEvent,
  YEvent: YEvent,
  YMapEvent: YMapEvent,
  YTextEvent: YTextEvent,
  YXmlEvent: YXmlEvent,
  applyUpdate: applyUpdate,
  applyUpdateV2: applyUpdateV2,
  cleanupYTextFormatting: cleanupYTextFormatting,
  compareIDs: compareIDs,
  compareRelativePositions: compareRelativePositions,
  convertUpdateFormatV1ToV2: convertUpdateFormatV1ToV2,
  convertUpdateFormatV2ToV1: convertUpdateFormatV2ToV1,
  createAbsolutePositionFromRelativePosition: createAbsolutePositionFromRelativePosition,
  createDeleteSet: createDeleteSet,
  createDeleteSetFromStructStore: createDeleteSetFromStructStore,
  createDocFromSnapshot: createDocFromSnapshot,
  createID: createID,
  createRelativePositionFromJSON: createRelativePositionFromJSON,
  createRelativePositionFromTypeIndex: createRelativePositionFromTypeIndex,
  createSnapshot: createSnapshot,
  decodeRelativePosition: decodeRelativePosition,
  decodeSnapshot: decodeSnapshot,
  decodeSnapshotV2: decodeSnapshotV2,
  decodeStateVector: decodeStateVector,
  decodeUpdate: decodeUpdate,
  decodeUpdateV2: decodeUpdateV2,
  diffUpdate: diffUpdate,
  diffUpdateV2: diffUpdateV2,
  emptySnapshot: emptySnapshot,
  encodeRelativePosition: encodeRelativePosition,
  encodeSnapshot: encodeSnapshot,
  encodeSnapshotV2: encodeSnapshotV2,
  encodeStateAsUpdate: encodeStateAsUpdate,
  encodeStateAsUpdateV2: encodeStateAsUpdateV2,
  encodeStateVector: encodeStateVector,
  encodeStateVectorFromUpdate: encodeStateVectorFromUpdate,
  encodeStateVectorFromUpdateV2: encodeStateVectorFromUpdateV2,
  equalDeleteSets: equalDeleteSets,
  equalSnapshots: equalSnapshots,
  findIndexSS: findIndexSS,
  findRootTypeKey: findRootTypeKey,
  getItem: getItem,
  getState: getState,
  getTypeChildren: getTypeChildren,
  isDeleted: isDeleted,
  isParentOf: isParentOf,
  iterateDeletedStructs: iterateDeletedStructs,
  logType: logType,
  logUpdate: logUpdate,
  logUpdateV2: logUpdateV2,
  mergeDeleteSets: mergeDeleteSets,
  mergeUpdates: mergeUpdates,
  mergeUpdatesV2: mergeUpdatesV2,
  obfuscateUpdate: obfuscateUpdate,
  obfuscateUpdateV2: obfuscateUpdateV2,
  parseUpdateMeta: parseUpdateMeta,
  parseUpdateMetaV2: parseUpdateMetaV2,
  readUpdate: readUpdate$1,
  readUpdateV2: readUpdateV2,
  relativePositionToJSON: relativePositionToJSON,
  snapshot: snapshot$1,
  snapshotContainsUpdate: snapshotContainsUpdate,
  transact: transact,
  tryGc: tryGc$1,
  typeListToArraySnapshot: typeListToArraySnapshot,
  typeMapGetAllSnapshot: typeMapGetAllSnapshot,
  typeMapGetSnapshot: typeMapGetSnapshot
});

/**
 * @module sync-protocol
 */


/**
 * @typedef {Map<number, number>} StateMap
 */

/**
 * Core Yjs defines two message types:
 * • YjsSyncStep1: Includes the State Set of the sending client. When received, the client should reply with YjsSyncStep2.
 * • YjsSyncStep2: Includes all missing structs and the complete delete set. When received, the client is assured that it
 *   received all information from the remote client.
 *
 * In a peer-to-peer network, you may want to introduce a SyncDone message type. Both parties should initiate the connection
 * with SyncStep1. When a client received SyncStep2, it should reply with SyncDone. When the local client received both
 * SyncStep2 and SyncDone, it is assured that it is synced to the remote client.
 *
 * In a client-server model, you want to handle this differently: The client should initiate the connection with SyncStep1.
 * When the server receives SyncStep1, it should reply with SyncStep2 immediately followed by SyncStep1. The client replies
 * with SyncStep2 when it receives SyncStep1. Optionally the server may send a SyncDone after it received SyncStep2, so the
 * client knows that the sync is finished.  There are two reasons for this more elaborated sync model: 1. This protocol can
 * easily be implemented on top of http and websockets. 2. The server should only reply to requests, and not initiate them.
 * Therefore it is necessary that the client initiates the sync.
 *
 * Construction of a message:
 * [messageType : varUint, message definition..]
 *
 * Note: A message does not include information about the room name. This must to be handled by the upper layer protocol!
 *
 * stringify[messageType] stringifies a message definition (messageType is already read from the bufffer)
 */

const messageYjsSyncStep1 = 0;
const messageYjsSyncStep2 = 1;
const messageYjsUpdate = 2;

/**
 * Create a sync step 1 message based on the state of the current shared document.
 *
 * @param {encoding.Encoder} encoder
 * @param {Y.Doc} doc
 */
const writeSyncStep1 = (encoder, doc) => {
  encoding__namespace.writeVarUint(encoder, messageYjsSyncStep1);
  const sv = encodeStateVector(doc);
  encoding__namespace.writeVarUint8Array(encoder, sv);
};

/**
 * @param {encoding.Encoder} encoder
 * @param {Y.Doc} doc
 * @param {Uint8Array} [encodedStateVector]
 */
const writeSyncStep2 = (encoder, doc, encodedStateVector) => {
  encoding__namespace.writeVarUint(encoder, messageYjsSyncStep2);
  encoding__namespace.writeVarUint8Array(encoder, encodeStateAsUpdate(doc, encodedStateVector));
};

/**
 * Read SyncStep1 message and reply with SyncStep2.
 *
 * @param {decoding.Decoder} decoder The reply to the received message
 * @param {encoding.Encoder} encoder The received message
 * @param {Y.Doc} doc
 */
const readSyncStep1 = (decoder, encoder, doc) =>
  writeSyncStep2(encoder, doc, decoding__namespace.readVarUint8Array(decoder));

/**
 * Read and apply Structs and then DeleteStore to a y instance.
 *
 * @param {decoding.Decoder} decoder
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 */
const readSyncStep2 = (decoder, doc, transactionOrigin) => {
  try {
    applyUpdate(doc, decoding__namespace.readVarUint8Array(decoder), transactionOrigin);
  } catch (error) {
    // This catches errors that are thrown by event handlers
    console.error('Caught error while handling a Yjs update', error);
  }
};

/**
 * @param {encoding.Encoder} encoder
 * @param {Uint8Array} update
 */
const writeUpdate = (encoder, update) => {
  encoding__namespace.writeVarUint(encoder, messageYjsUpdate);
  encoding__namespace.writeVarUint8Array(encoder, update);
};

/**
 * Read and apply Structs and then DeleteStore to a y instance.
 *
 * @param {decoding.Decoder} decoder
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 */
const readUpdate = readSyncStep2;

/**
 * @param {decoding.Decoder} decoder A message received from another client
 * @param {encoding.Encoder} encoder The reply message. Does not need to be sent if empty.
 * @param {Y.Doc} doc
 * @param {any} transactionOrigin
 */
const readSyncMessage = (decoder, encoder, doc, transactionOrigin) => {
  const messageType = decoding__namespace.readVarUint(decoder);
  switch (messageType) {
    case messageYjsSyncStep1:
      readSyncStep1(decoder, encoder, doc);
      break
    case messageYjsSyncStep2:
      readSyncStep2(decoder, doc, transactionOrigin);
      break
    case messageYjsUpdate:
      readUpdate(decoder, doc, transactionOrigin);
      break
    default:
      throw new Error('Unknown message type')
  }
  return messageType
};

if (typeof window !== 'undefined') {
  // @ts-ignore
  window.Y = Y$1; // eslint-disable-line
}

/**
 * @param {TestYInstance} y // publish message created by `y` to all other online clients
 * @param {Uint8Array} m
 */
const broadcastMessage = (y, m) => {
  if (y.tc.onlineConns.has(y)) {
    y.tc.onlineConns.forEach(remoteYInstance => {
      if (remoteYInstance !== y) {
        remoteYInstance._receive(m, y);
      }
    });
  }
};

let useV2 = false;

const encV1$1 = {
  encodeStateAsUpdate: encodeStateAsUpdate,
  mergeUpdates: mergeUpdates,
  applyUpdate: applyUpdate,
  logUpdate: logUpdate,
  updateEventName: /** @type {'update'} */ ('update'),
  diffUpdate: diffUpdate
};

const encV2$1 = {
  encodeStateAsUpdate: encodeStateAsUpdateV2,
  mergeUpdates: mergeUpdatesV2,
  applyUpdate: applyUpdateV2,
  logUpdate: logUpdateV2,
  updateEventName: /** @type {'updateV2'} */ ('updateV2'),
  diffUpdate: diffUpdateV2
};

let enc = encV1$1;

const useV1Encoding = () => {
  useV2 = false;
  enc = encV1$1;
};

const useV2Encoding = () => {
  console.error('sync protocol doesnt support v2 protocol yet, fallback to v1 encoding'); // @Todo
  useV2 = false;
  enc = encV1$1;
};

class TestYInstance extends Doc {
  /**
   * @param {TestConnector} testConnector
   * @param {number} clientID
   */
  constructor (testConnector, clientID) {
    super();
    this.userID = clientID; // overwriting clientID
    /**
     * @type {TestConnector}
     */
    this.tc = testConnector;
    /**
     * @type {Map<TestYInstance, Array<Uint8Array>>}
     */
    this.receiving = new Map();
    testConnector.allConns.add(this);
    /**
     * The list of received updates.
     * We are going to merge them later using Y.mergeUpdates and check if the resulting document is correct.
     * @type {Array<Uint8Array>}
     */
    this.updates = [];
    // set up observe on local model
    this.on(enc.updateEventName, /** @param {Uint8Array} update @param {any} origin */ (update, origin) => {
      if (origin !== testConnector) {
        const encoder = encoding__namespace.createEncoder();
        writeUpdate(encoder, update);
        broadcastMessage(this, encoding__namespace.toUint8Array(encoder));
      }
      this.updates.push(update);
    });
    this.connect();
  }

  /**
   * Disconnect from TestConnector.
   */
  disconnect () {
    this.receiving = new Map();
    this.tc.onlineConns.delete(this);
  }

  /**
   * Append yourself to the list of known Y instances in testconnector.
   * Also initiate sync with all clients.
   */
  connect () {
    if (!this.tc.onlineConns.has(this)) {
      this.tc.onlineConns.add(this);
      const encoder = encoding__namespace.createEncoder();
      writeSyncStep1(encoder, this);
      // publish SyncStep1
      broadcastMessage(this, encoding__namespace.toUint8Array(encoder));
      this.tc.onlineConns.forEach(remoteYInstance => {
        if (remoteYInstance !== this) {
          // remote instance sends instance to this instance
          const encoder = encoding__namespace.createEncoder();
          writeSyncStep1(encoder, remoteYInstance);
          this._receive(encoding__namespace.toUint8Array(encoder), remoteYInstance);
        }
      });
    }
  }

  /**
   * Receive a message from another client. This message is only appended to the list of receiving messages.
   * TestConnector decides when this client actually reads this message.
   *
   * @param {Uint8Array} message
   * @param {TestYInstance} remoteClient
   */
  _receive (message, remoteClient) {
    map__namespace.setIfUndefined(this.receiving, remoteClient, () => /** @type {Array<Uint8Array>} */ ([])).push(message);
  }
}

/**
 * Keeps track of TestYInstances.
 *
 * The TestYInstances add/remove themselves from the list of connections maiained in this object.
 * I think it makes sense. Deal with it.
 */
class TestConnector {
  /**
   * @param {prng.PRNG} gen
   */
  constructor (gen) {
    /**
     * @type {Set<TestYInstance>}
     */
    this.allConns = new Set();
    /**
     * @type {Set<TestYInstance>}
     */
    this.onlineConns = new Set();
    /**
     * @type {prng.PRNG}
     */
    this.prng = gen;
  }

  /**
   * Create a new Y instance and add it to the list of connections
   * @param {number} clientID
   */
  createY (clientID) {
    return new TestYInstance(this, clientID)
  }

  /**
   * Choose random connection and flush a random message from a random sender.
   *
   * If this function was unable to flush a message, because there are no more messages to flush, it returns false. true otherwise.
   * @return {boolean}
   */
  flushRandomMessage () {
    const gen = this.prng;
    const conns = Array.from(this.onlineConns).filter(conn => conn.receiving.size > 0);
    if (conns.length > 0) {
      const receiver = prng__namespace.oneOf(gen, conns);
      const [sender, messages] = prng__namespace.oneOf(gen, Array.from(receiver.receiving));
      const m = messages.shift();
      if (messages.length === 0) {
        receiver.receiving.delete(sender);
      }
      if (m === undefined) {
        return this.flushRandomMessage()
      }
      const encoder = encoding__namespace.createEncoder();
      // console.log('receive (' + sender.userID + '->' + receiver.userID + '):\n', syncProtocol.stringifySyncMessage(decoding.createDecoder(m), receiver))
      // do not publish data created when this function is executed (could be ss2 or update message)
      readSyncMessage(decoding__namespace.createDecoder(m), encoder, receiver, receiver.tc);
      if (encoding__namespace.length(encoder) > 0) {
        // send reply message
        sender._receive(encoding__namespace.toUint8Array(encoder), receiver);
      }
      return true
    }
    return false
  }

  /**
   * @return {boolean} True iff this function actually flushed something
   */
  flushAllMessages () {
    let didSomething = false;
    while (this.flushRandomMessage()) {
      didSomething = true;
    }
    return didSomething
  }

  reconnectAll () {
    this.allConns.forEach(conn => conn.connect());
  }

  disconnectAll () {
    this.allConns.forEach(conn => conn.disconnect());
  }

  syncAll () {
    this.reconnectAll();
    this.flushAllMessages();
  }

  /**
   * @return {boolean} Whether it was possible to disconnect a randon connection.
   */
  disconnectRandom () {
    if (this.onlineConns.size === 0) {
      return false
    }
    prng__namespace.oneOf(this.prng, Array.from(this.onlineConns)).disconnect();
    return true
  }

  /**
   * @return {boolean} Whether it was possible to reconnect a random connection.
   */
  reconnectRandom () {
    /**
     * @type {Array<TestYInstance>}
     */
    const reconnectable = [];
    this.allConns.forEach(conn => {
      if (!this.onlineConns.has(conn)) {
        reconnectable.push(conn);
      }
    });
    if (reconnectable.length === 0) {
      return false
    }
    prng__namespace.oneOf(this.prng, reconnectable).connect();
    return true
  }
}

/**
 * @template T
 * @param {t.TestCase} tc
 * @param {{users?:number}} conf
 * @param {InitTestObjectCallback<T>} [initTestObject]
 * @return {{testObjects:Array<any>,testConnector:TestConnector,users:Array<TestYInstance>,array0:Y.Array<any>,array1:Y.Array<any>,array2:Y.Array<any>,map0:Y.Map<any>,map1:Y.Map<any>,map2:Y.Map<any>,map3:Y.Map<any>,text0:Y.Text,text1:Y.Text,text2:Y.Text,xml0:Y.XmlElement,xml1:Y.XmlElement,xml2:Y.XmlElement}}
 */
const init$1 = (tc, { users = 5 } = {}, initTestObject) => {
  /**
   * @type {Object<string,any>}
   */
  const result = {
    users: []
  };
  const gen = tc.prng;
  // choose an encoding approach at random
  if (prng__namespace.bool(gen)) {
    useV2Encoding();
  } else {
    useV1Encoding();
  }

  const testConnector = new TestConnector(gen);
  result.testConnector = testConnector;
  for (let i = 0; i < users; i++) {
    const y = testConnector.createY(i);
    y.clientID = i;
    result.users.push(y);
    result['array' + i] = y.getArray('array');
    result['map' + i] = y.getMap('map');
    result['xml' + i] = y.get('xml', YXmlElement);
    result['text' + i] = y.getText('text');
  }
  testConnector.syncAll();
  result.testObjects = result.users.map(initTestObject || (() => null));
  useV1Encoding();
  return /** @type {any} */ (result)
};

/**
 * 1. reconnect and flush all
 * 2. user 0 gc
 * 3. get type content
 * 4. disconnect & reconnect all (so gc is propagated)
 * 5. compare os, ds, ss
 *
 * @param {Array<TestYInstance>} users
 */
const compare$1 = users => {
  users.forEach(u => u.connect());
  while (users[0].tc.flushAllMessages()) {} // eslint-disable-line
  // For each document, merge all received document updates with Y.mergeUpdates and create a new document which will be added to the list of "users"
  // This ensures that mergeUpdates works correctly
  const mergedDocs = users.map(user => {
    const ydoc = new Doc();
    enc.applyUpdate(ydoc, enc.mergeUpdates(user.updates));
    return ydoc
  });
  users.push(.../** @type {any} */(mergedDocs));
  const userArrayValues = users.map(u => u.getArray('array').toJSON());
  const userMapValues = users.map(u => u.getMap('map').toJSON());
  const userXmlValues = users.map(u => u.get('xml', YXmlElement).toString());
  const userTextValues = users.map(u => u.getText('text').toDelta());
  for (const u of users) {
    t__namespace.assert(u.store.pendingDs === null);
    t__namespace.assert(u.store.pendingStructs === null);
  }
  // Test Array iterator
  t__namespace.compare(users[0].getArray('array').toArray(), Array.from(users[0].getArray('array')));
  // Test Map iterator
  const ymapkeys = Array.from(users[0].getMap('map').keys());
  t__namespace.assert(ymapkeys.length === Object.keys(userMapValues[0]).length);
  ymapkeys.forEach(key => t__namespace.assert(object__namespace.hasProperty(userMapValues[0], key)));
  /**
   * @type {Object<string,any>}
   */
  const mapRes = {};
  for (const [k, v] of users[0].getMap('map')) {
    mapRes[k] = v instanceof AbstractType ? v.toJSON() : v;
  }
  t__namespace.compare(userMapValues[0], mapRes);
  // Compare all users
  for (let i = 0; i < users.length - 1; i++) {
    t__namespace.compare(userArrayValues[i].length, users[i].getArray('array').length);
    t__namespace.compare(userArrayValues[i], userArrayValues[i + 1]);
    t__namespace.compare(userMapValues[i], userMapValues[i + 1]);
    t__namespace.compare(userXmlValues[i], userXmlValues[i + 1]);
    t__namespace.compare(userTextValues[i].map(/** @param {any} a */ a => typeof a.insert === 'string' ? a.insert : ' ').join('').length, users[i].getText('text').length);
    t__namespace.compare(userTextValues[i], userTextValues[i + 1], '', (_constructor, a, b) => {
      if (a instanceof AbstractType) {
        t__namespace.compare(a.toJSON(), b.toJSON());
      } else if (a !== b) {
        t__namespace.fail('Deltas dont match');
      }
      return true
    });
    t__namespace.compare(encodeStateVector(users[i]), encodeStateVector(users[i + 1]));
    equalDeleteSets(createDeleteSetFromStructStore(users[i].store), createDeleteSetFromStructStore(users[i + 1].store));
    compareStructStores(users[i].store, users[i + 1].store);
    t__namespace.compare(encodeSnapshot(snapshot$1(users[i])), encodeSnapshot(snapshot$1(users[i + 1])));
  }
  users.map(u => u.destroy());
};

/**
 * @param {Y.Item?} a
 * @param {Y.Item?} b
 * @return {boolean}
 */
const compareItemIDs = (a, b) => a === b || (a !== null && b != null && compareIDs(a.id, b.id));

/**
 * @param {import('../src/internals.js').StructStore} ss1
 * @param {import('../src/internals.js').StructStore} ss2
 */
const compareStructStores = (ss1, ss2) => {
  t__namespace.assert(ss1.clients.size === ss2.clients.size);
  for (const [client, structs1] of ss1.clients) {
    const structs2 = /** @type {Array<Y.AbstractStruct>} */ (ss2.clients.get(client));
    t__namespace.assert(structs2 !== undefined && structs1.length === structs2.length);
    for (let i = 0; i < structs1.length; i++) {
      const s1 = structs1[i];
      const s2 = structs2[i];
      // checks for abstract struct
      if (
        s1.constructor !== s2.constructor ||
        !compareIDs(s1.id, s2.id) ||
        s1.deleted !== s2.deleted ||
        // @ts-ignore
        s1.length !== s2.length
      ) {
        t__namespace.fail('Structs dont match');
      }
      if (s1 instanceof Item) {
        if (
          !(s2 instanceof Item) ||
          !((s1.left === null && s2.left === null) || (s1.left !== null && s2.left !== null && compareIDs(s1.left.lastId, s2.left.lastId))) ||
          !compareItemIDs(s1.right, s2.right) ||
          !compareIDs(s1.origin, s2.origin) ||
          !compareIDs(s1.rightOrigin, s2.rightOrigin) ||
          s1.parentSub !== s2.parentSub
        ) {
          return t__namespace.fail('Items dont match')
        }
        // make sure that items are connected correctly
        t__namespace.assert(s1.left === null || s1.left.right === s1);
        t__namespace.assert(s1.right === null || s1.right.left === s1);
        t__namespace.assert(s2.left === null || s2.left.right === s2);
        t__namespace.assert(s2.right === null || s2.right.left === s2);
      }
    }
  }
};

/**
 * @template T
 * @callback InitTestObjectCallback
 * @param {TestYInstance} y
 * @return {T}
 */

/**
 * @template T
 * @param {t.TestCase} tc
 * @param {Array<function(Y.Doc,prng.PRNG,T):void>} mods
 * @param {number} iterations
 * @param {InitTestObjectCallback<T>} [initTestObject]
 */
const applyRandomTests = (tc, mods, iterations, initTestObject) => {
  const gen = tc.prng;
  const result = init$1(tc, { users: 5 }, initTestObject);
  const { testConnector, users } = result;
  for (let i = 0; i < iterations; i++) {
    if (prng__namespace.int32(gen, 0, 100) <= 2) {
      // 2% chance to disconnect/reconnect a random user
      if (prng__namespace.bool(gen)) {
        testConnector.disconnectRandom();
      } else {
        testConnector.reconnectRandom();
      }
    } else if (prng__namespace.int32(gen, 0, 100) <= 1) {
      // 1% chance to flush all
      testConnector.flushAllMessages();
    } else if (prng__namespace.int32(gen, 0, 100) <= 50) {
      // 50% chance to flush a random message
      testConnector.flushRandomMessage();
    }
    const user = prng__namespace.int32(gen, 0, users.length - 1);
    const test = prng__namespace.oneOf(gen, mods);
    test(users[user], gen, result.testObjects[user]);
  }
  compare$1(users);
  return result
};

var Y = /*#__PURE__*/Object.freeze({
  __proto__: null,
  AbsolutePosition: AbsolutePosition,
  AbstractConnector: AbstractConnector,
  AbstractStruct: AbstractStruct,
  AbstractType: AbstractType,
  Array: YArray,
  ContentAny: ContentAny,
  ContentBinary: ContentBinary,
  ContentDeleted: ContentDeleted,
  ContentDoc: ContentDoc,
  ContentEmbed: ContentEmbed,
  ContentFormat: ContentFormat,
  ContentJSON: ContentJSON,
  ContentString: ContentString,
  ContentType: ContentType,
  Doc: Doc,
  GC: GC,
  ID: ID,
  Item: Item,
  Map: YMap,
  PermanentUserData: PermanentUserData,
  RelativePosition: RelativePosition,
  Skip: Skip,
  Snapshot: Snapshot,
  TestConnector: TestConnector,
  TestYInstance: TestYInstance,
  Text: YText,
  Transaction: Transaction,
  UndoManager: UndoManager,
  UpdateDecoderV1: UpdateDecoderV1,
  UpdateDecoderV2: UpdateDecoderV2,
  UpdateEncoderV1: UpdateEncoderV1,
  UpdateEncoderV2: UpdateEncoderV2,
  XmlElement: YXmlElement,
  XmlFragment: YXmlFragment,
  XmlHook: YXmlHook,
  XmlText: YXmlText,
  YArrayEvent: YArrayEvent,
  YEvent: YEvent,
  YMapEvent: YMapEvent,
  YTextEvent: YTextEvent,
  YXmlEvent: YXmlEvent,
  applyRandomTests: applyRandomTests,
  applyUpdate: applyUpdate,
  applyUpdateV2: applyUpdateV2,
  cleanupYTextFormatting: cleanupYTextFormatting,
  compare: compare$1,
  compareIDs: compareIDs,
  compareItemIDs: compareItemIDs,
  compareRelativePositions: compareRelativePositions,
  compareStructStores: compareStructStores,
  convertUpdateFormatV1ToV2: convertUpdateFormatV1ToV2,
  convertUpdateFormatV2ToV1: convertUpdateFormatV2ToV1,
  createAbsolutePositionFromRelativePosition: createAbsolutePositionFromRelativePosition,
  createDeleteSet: createDeleteSet,
  createDeleteSetFromStructStore: createDeleteSetFromStructStore,
  createDocFromSnapshot: createDocFromSnapshot,
  createID: createID,
  createRelativePositionFromJSON: createRelativePositionFromJSON,
  createRelativePositionFromTypeIndex: createRelativePositionFromTypeIndex,
  createSnapshot: createSnapshot,
  decodeRelativePosition: decodeRelativePosition,
  decodeSnapshot: decodeSnapshot,
  decodeSnapshotV2: decodeSnapshotV2,
  decodeStateVector: decodeStateVector,
  decodeUpdate: decodeUpdate,
  decodeUpdateV2: decodeUpdateV2,
  diffUpdate: diffUpdate,
  diffUpdateV2: diffUpdateV2,
  emptySnapshot: emptySnapshot,
  get enc () { return enc; },
  encV1: encV1$1,
  encV2: encV2$1,
  encodeRelativePosition: encodeRelativePosition,
  encodeSnapshot: encodeSnapshot,
  encodeSnapshotV2: encodeSnapshotV2,
  encodeStateAsUpdate: encodeStateAsUpdate,
  encodeStateAsUpdateV2: encodeStateAsUpdateV2,
  encodeStateVector: encodeStateVector,
  encodeStateVectorFromUpdate: encodeStateVectorFromUpdate,
  encodeStateVectorFromUpdateV2: encodeStateVectorFromUpdateV2,
  equalDeleteSets: equalDeleteSets,
  equalSnapshots: equalSnapshots,
  findIndexSS: findIndexSS,
  findRootTypeKey: findRootTypeKey,
  getItem: getItem,
  getState: getState,
  getTypeChildren: getTypeChildren,
  init: init$1,
  isDeleted: isDeleted,
  isParentOf: isParentOf,
  iterateDeletedStructs: iterateDeletedStructs,
  logType: logType,
  logUpdate: logUpdate,
  logUpdateV2: logUpdateV2,
  mergeDeleteSets: mergeDeleteSets,
  mergeUpdates: mergeUpdates,
  mergeUpdatesV2: mergeUpdatesV2,
  obfuscateUpdate: obfuscateUpdate,
  obfuscateUpdateV2: obfuscateUpdateV2,
  parseUpdateMeta: parseUpdateMeta,
  parseUpdateMetaV2: parseUpdateMetaV2,
  readUpdate: readUpdate$1,
  readUpdateV2: readUpdateV2,
  relativePositionToJSON: relativePositionToJSON,
  snapshot: snapshot$1,
  snapshotContainsUpdate: snapshotContainsUpdate,
  transact: transact,
  tryGc: tryGc$1,
  typeListToArraySnapshot: typeListToArraySnapshot,
  typeMapGetAllSnapshot: typeMapGetAllSnapshot,
  typeMapGetSnapshot: typeMapGetSnapshot,
  get useV2 () { return useV2; }
});

/**
 * @param {t.TestCase} _tc
 */
const testIterators = _tc => {
  const ydoc = new Doc();
  /**
   * @type {Y.Map<number>}
   */
  const ymap = ydoc.getMap();
  // we are only checking if the type assumptions are correct
  /**
   * @type {Array<number>}
   */
  const vals = Array.from(ymap.values());
  /**
   * @type {Array<[string,number]>}
   */
  const entries = Array.from(ymap.entries());
  /**
   * @type {Array<string>}
   */
  const keys = Array.from(ymap.keys());
  console.log(vals, entries, keys);
};

/**
 * Computing event changes after transaction should result in an error. See yjs#539
 *
 * @param {t.TestCase} _tc
 */
const testMapEventError = _tc => {
  const doc = new Doc();
  const ymap = doc.getMap();
  /**
   * @type {any}
   */
  let event = null;
  ymap.observe((e) => {
    event = e;
  });
  t__namespace.fails(() => {
    t__namespace.info(event.keys);
  });
  t__namespace.fails(() => {
    t__namespace.info(event.keys);
  });
};

/**
 * @param {t.TestCase} tc
 */
const testMapHavingIterableAsConstructorParamTests = tc => {
  const { map0 } = init$1(tc, { users: 1 });

  const m1 = new YMap(Object.entries({ number: 1, string: 'hello' }));
  map0.set('m1', m1);
  t__namespace.assert(m1.get('number') === 1);
  t__namespace.assert(m1.get('string') === 'hello');

  const m2 = new YMap([
    ['object', { x: 1 }],
    ['boolean', true]
  ]);
  map0.set('m2', m2);
  t__namespace.assert(m2.get('object').x === 1);
  t__namespace.assert(m2.get('boolean') === true);

  const m3 = new YMap([...m1, ...m2]);
  map0.set('m3', m3);
  t__namespace.assert(m3.get('number') === 1);
  t__namespace.assert(m3.get('string') === 'hello');
  t__namespace.assert(m3.get('object').x === 1);
  t__namespace.assert(m3.get('boolean') === true);
};

/**
 * @param {t.TestCase} tc
 */
const testBasicMapTests = tc => {
  const { testConnector, users, map0, map1, map2 } = init$1(tc, { users: 3 });
  users[2].disconnect();

  map0.set('null', null);
  map0.set('number', 1);
  map0.set('string', 'hello Y');
  map0.set('object', { key: { key2: 'value' } });
  map0.set('y-map', new YMap());
  map0.set('boolean1', true);
  map0.set('boolean0', false);
  const map = map0.get('y-map');
  map.set('y-array', new YArray());
  const array = map.get('y-array');
  array.insert(0, [0]);
  array.insert(0, [-1]);

  t__namespace.assert(map0.get('null') === null, 'client 0 computed the change (null)');
  t__namespace.assert(map0.get('number') === 1, 'client 0 computed the change (number)');
  t__namespace.assert(map0.get('string') === 'hello Y', 'client 0 computed the change (string)');
  t__namespace.assert(map0.get('boolean0') === false, 'client 0 computed the change (boolean)');
  t__namespace.assert(map0.get('boolean1') === true, 'client 0 computed the change (boolean)');
  t__namespace.compare(map0.get('object'), { key: { key2: 'value' } }, 'client 0 computed the change (object)');
  t__namespace.assert(map0.get('y-map').get('y-array').get(0) === -1, 'client 0 computed the change (type)');
  t__namespace.assert(map0.size === 7, 'client 0 map has correct size');

  users[2].connect();
  testConnector.flushAllMessages();

  t__namespace.assert(map1.get('null') === null, 'client 1 received the update (null)');
  t__namespace.assert(map1.get('number') === 1, 'client 1 received the update (number)');
  t__namespace.assert(map1.get('string') === 'hello Y', 'client 1 received the update (string)');
  t__namespace.assert(map1.get('boolean0') === false, 'client 1 computed the change (boolean)');
  t__namespace.assert(map1.get('boolean1') === true, 'client 1 computed the change (boolean)');
  t__namespace.compare(map1.get('object'), { key: { key2: 'value' } }, 'client 1 received the update (object)');
  t__namespace.assert(map1.get('y-map').get('y-array').get(0) === -1, 'client 1 received the update (type)');
  t__namespace.assert(map1.size === 7, 'client 1 map has correct size');

  // compare disconnected user
  t__namespace.assert(map2.get('null') === null, 'client 2 received the update (null) - was disconnected');
  t__namespace.assert(map2.get('number') === 1, 'client 2 received the update (number) - was disconnected');
  t__namespace.assert(map2.get('string') === 'hello Y', 'client 2 received the update (string) - was disconnected');
  t__namespace.assert(map2.get('boolean0') === false, 'client 2 computed the change (boolean)');
  t__namespace.assert(map2.get('boolean1') === true, 'client 2 computed the change (boolean)');
  t__namespace.compare(map2.get('object'), { key: { key2: 'value' } }, 'client 2 received the update (object) - was disconnected');
  t__namespace.assert(map2.get('y-map').get('y-array').get(0) === -1, 'client 2 received the update (type) - was disconnected');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetOfMapProperty = tc => {
  const { testConnector, users, map0 } = init$1(tc, { users: 2 });
  map0.set('stuff', 'stuffy');
  map0.set('undefined', undefined);
  map0.set('null', null);
  t__namespace.compare(map0.get('stuff'), 'stuffy');

  testConnector.flushAllMessages();

  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.compare(u.get('stuff'), 'stuffy');
    t__namespace.assert(u.get('undefined') === undefined, 'undefined');
    t__namespace.compare(u.get('null'), null, 'null');
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testYmapSetsYmap = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  const map = map0.set('Map', new YMap());
  t__namespace.assert(map0.get('Map') === map);
  map.set('one', 1);
  t__namespace.compare(map.get('one'), 1);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testYmapSetsYarray = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  const array = map0.set('Array', new YArray());
  t__namespace.assert(array === map0.get('Array'));
  array.insert(0, [1, 2, 3]);
  // @ts-ignore
  t__namespace.compare(map0.toJSON(), { Array: [1, 2, 3] });
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetOfMapPropertySyncs = tc => {
  const { testConnector, users, map0 } = init$1(tc, { users: 2 });
  map0.set('stuff', 'stuffy');
  t__namespace.compare(map0.get('stuff'), 'stuffy');
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.compare(u.get('stuff'), 'stuffy');
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetOfMapPropertyWithConflict = tc => {
  const { testConnector, users, map0, map1 } = init$1(tc, { users: 3 });
  map0.set('stuff', 'c0');
  map1.set('stuff', 'c1');
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.compare(u.get('stuff'), 'c1');
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testSizeAndDeleteOfMapProperty = tc => {
  const { map0 } = init$1(tc, { users: 1 });
  map0.set('stuff', 'c0');
  map0.set('otherstuff', 'c1');
  t__namespace.assert(map0.size === 2, `map size is ${map0.size} expected 2`);
  map0.delete('stuff');
  t__namespace.assert(map0.size === 1, `map size after delete is ${map0.size}, expected 1`);
  map0.delete('otherstuff');
  t__namespace.assert(map0.size === 0, `map size after delete is ${map0.size}, expected 0`);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetAndDeleteOfMapProperty = tc => {
  const { testConnector, users, map0, map1 } = init$1(tc, { users: 3 });
  map0.set('stuff', 'c0');
  map1.set('stuff', 'c1');
  map1.delete('stuff');
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.assert(u.get('stuff') === undefined);
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testSetAndClearOfMapProperties = tc => {
  const { testConnector, users, map0 } = init$1(tc, { users: 1 });
  map0.set('stuff', 'c0');
  map0.set('otherstuff', 'c1');
  map0.clear();
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.assert(u.get('stuff') === undefined);
    t__namespace.assert(u.get('otherstuff') === undefined);
    t__namespace.assert(u.size === 0, `map size after clear is ${u.size}, expected 0`);
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testSetAndClearOfMapPropertiesWithConflicts = tc => {
  const { testConnector, users, map0, map1, map2, map3 } = init$1(tc, { users: 4 });
  map0.set('stuff', 'c0');
  map1.set('stuff', 'c1');
  map1.set('stuff', 'c2');
  map2.set('stuff', 'c3');
  testConnector.flushAllMessages();
  map0.set('otherstuff', 'c0');
  map1.set('otherstuff', 'c1');
  map2.set('otherstuff', 'c2');
  map3.set('otherstuff', 'c3');
  map3.clear();
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.assert(u.get('stuff') === undefined);
    t__namespace.assert(u.get('otherstuff') === undefined);
    t__namespace.assert(u.size === 0, `map size after clear is ${u.size}, expected 0`);
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetOfMapPropertyWithThreeConflicts = tc => {
  const { testConnector, users, map0, map1, map2 } = init$1(tc, { users: 3 });
  map0.set('stuff', 'c0');
  map1.set('stuff', 'c1');
  map1.set('stuff', 'c2');
  map2.set('stuff', 'c3');
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.compare(u.get('stuff'), 'c3');
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testGetAndSetAndDeleteOfMapPropertyWithThreeConflicts = tc => {
  const { testConnector, users, map0, map1, map2, map3 } = init$1(tc, { users: 4 });
  map0.set('stuff', 'c0');
  map1.set('stuff', 'c1');
  map1.set('stuff', 'c2');
  map2.set('stuff', 'c3');
  testConnector.flushAllMessages();
  map0.set('stuff', 'deleteme');
  map1.set('stuff', 'c1');
  map2.set('stuff', 'c2');
  map3.set('stuff', 'c3');
  map3.delete('stuff');
  testConnector.flushAllMessages();
  for (const user of users) {
    const u = user.getMap('map');
    t__namespace.assert(u.get('stuff') === undefined);
  }
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testObserveDeepProperties = tc => {
  const { testConnector, users, map1, map2, map3 } = init$1(tc, { users: 4 });
  const _map1 = map1.set('map', new YMap());
  let calls = 0;
  let dmapid;
  map1.observeDeep(events => {
    events.forEach(event => {
      calls++;
      // @ts-ignore
      t__namespace.assert(event.keysChanged.has('deepmap'));
      t__namespace.assert(event.path.length === 1);
      t__namespace.assert(event.path[0] === 'map');
      // @ts-ignore
      dmapid = event.target.get('deepmap')._item.id;
    });
  });
  testConnector.flushAllMessages();
  const _map3 = map3.get('map');
  _map3.set('deepmap', new YMap());
  testConnector.flushAllMessages();
  const _map2 = map2.get('map');
  _map2.set('deepmap', new YMap());
  testConnector.flushAllMessages();
  const dmap1 = _map1.get('deepmap');
  const dmap2 = _map2.get('deepmap');
  const dmap3 = _map3.get('deepmap');
  t__namespace.assert(calls > 0);
  t__namespace.assert(compareIDs(dmap1._item.id, dmap2._item.id));
  t__namespace.assert(compareIDs(dmap1._item.id, dmap3._item.id));
  // @ts-ignore we want the possibility of dmapid being undefined
  t__namespace.assert(compareIDs(dmap1._item.id, dmapid));
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testObserversUsingObservedeep = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  /**
   * @type {Array<Array<string|number>>}
   */
  const pathes = [];
  let calls = 0;
  map0.observeDeep(events => {
    events.forEach(event => {
      pathes.push(event.path);
    });
    calls++;
  });
  map0.set('map', new YMap());
  map0.get('map').set('array', new YArray());
  map0.get('map').get('array').insert(0, ['content']);
  t__namespace.assert(calls === 3);
  t__namespace.compare(pathes, [[], ['map'], ['map', 'array']]);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testPathsOfSiblingEvents = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  /**
   * @type {Array<Array<string|number>>}
   */
  const pathes = [];
  let calls = 0;
  const doc = users[0];
  map0.set('map', new YMap());
  map0.get('map').set('text1', new YText('initial'));
  map0.observeDeep(events => {
    events.forEach(event => {
      pathes.push(event.path);
    });
    calls++;
  });
  doc.transact(() => {
    map0.get('map').get('text1').insert(0, 'post-');
    map0.get('map').set('text2', new YText('new'));
  });
  t__namespace.assert(calls === 1);
  t__namespace.compare(pathes, [['map'], ['map', 'text1']]);
  compare$1(users);
};

// TODO: Test events in Y.Map
/**
 * @param {Object<string,any>} is
 * @param {Object<string,any>} should
 */
const compareEvent = (is, should) => {
  for (const key in should) {
    t__namespace.compare(should[key], is[key]);
  }
};

/**
 * @param {t.TestCase} tc
 */
const testThrowsAddAndUpdateAndDeleteEvents = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  /**
   * @type {Object<string,any>}
   */
  let event = {};
  map0.observe(e => {
    event = e; // just put it on event, should be thrown synchronously anyway
  });
  map0.set('stuff', 4);
  compareEvent(event, {
    target: map0,
    keysChanged: new Set(['stuff'])
  });
  // update, oldValue is in contents
  map0.set('stuff', new YArray());
  compareEvent(event, {
    target: map0,
    keysChanged: new Set(['stuff'])
  });
  // update, oldValue is in opContents
  map0.set('stuff', 5);
  // delete
  map0.delete('stuff');
  compareEvent(event, {
    keysChanged: new Set(['stuff']),
    target: map0
  });
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testThrowsDeleteEventsOnClear = tc => {
  const { users, map0 } = init$1(tc, { users: 2 });
  /**
   * @type {Object<string,any>}
   */
  let event = {};
  map0.observe(e => {
    event = e; // just put it on event, should be thrown synchronously anyway
  });
  // set values
  map0.set('stuff', 4);
  map0.set('otherstuff', new YArray());
  // clear
  map0.clear();
  compareEvent(event, {
    keysChanged: new Set(['stuff', 'otherstuff']),
    target: map0
  });
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testChangeEvent$1 = tc => {
  const { map0, users } = init$1(tc, { users: 2 });
  /**
   * @type {any}
   */
  let changes = null;
  /**
   * @type {any}
   */
  let keyChange = null;
  map0.observe(e => {
    changes = e.changes;
  });
  map0.set('a', 1);
  keyChange = changes.keys.get('a');
  t__namespace.assert(changes !== null && keyChange.action === 'add' && keyChange.oldValue === undefined);
  map0.set('a', 2);
  keyChange = changes.keys.get('a');
  t__namespace.assert(changes !== null && keyChange.action === 'update' && keyChange.oldValue === 1);
  users[0].transact(() => {
    map0.set('a', 3);
    map0.set('a', 4);
  });
  keyChange = changes.keys.get('a');
  t__namespace.assert(changes !== null && keyChange.action === 'update' && keyChange.oldValue === 2);
  users[0].transact(() => {
    map0.set('b', 1);
    map0.set('b', 2);
  });
  keyChange = changes.keys.get('b');
  t__namespace.assert(changes !== null && keyChange.action === 'add' && keyChange.oldValue === undefined);
  users[0].transact(() => {
    map0.set('c', 1);
    map0.delete('c');
  });
  t__namespace.assert(changes !== null && changes.keys.size === 0);
  users[0].transact(() => {
    map0.set('d', 1);
    map0.set('d', 2);
  });
  keyChange = changes.keys.get('d');
  t__namespace.assert(changes !== null && keyChange.action === 'add' && keyChange.oldValue === undefined);
  compare$1(users);
};

/**
 * @param {t.TestCase} _tc
 */
const testYmapEventExceptionsShouldCompleteTransaction = _tc => {
  const doc = new Doc();
  const map = doc.getMap('map');

  let updateCalled = false;
  let throwingObserverCalled = false;
  let throwingDeepObserverCalled = false;
  doc.on('update', () => {
    updateCalled = true;
  });

  const throwingObserver = () => {
    throwingObserverCalled = true;
    throw new Error('Failure')
  };

  const throwingDeepObserver = () => {
    throwingDeepObserverCalled = true;
    throw new Error('Failure')
  };

  map.observe(throwingObserver);
  map.observeDeep(throwingDeepObserver);

  t__namespace.fails(() => {
    map.set('y', '2');
  });

  t__namespace.assert(updateCalled);
  t__namespace.assert(throwingObserverCalled);
  t__namespace.assert(throwingDeepObserverCalled);

  // check if it works again
  updateCalled = false;
  throwingObserverCalled = false;
  throwingDeepObserverCalled = false;
  t__namespace.fails(() => {
    map.set('z', '3');
  });

  t__namespace.assert(updateCalled);
  t__namespace.assert(throwingObserverCalled);
  t__namespace.assert(throwingDeepObserverCalled);

  t__namespace.assert(map.get('z') === '3');
};

/**
 * @param {t.TestCase} tc
 */
const testYmapEventHasCorrectValueWhenSettingAPrimitive = tc => {
  const { users, map0 } = init$1(tc, { users: 3 });
  /**
   * @type {Object<string,any>}
   */
  let event = {};
  map0.observe(e => {
    event = e;
  });
  map0.set('stuff', 2);
  t__namespace.compare(event.value, event.target.get(event.name));
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testYmapEventHasCorrectValueWhenSettingAPrimitiveFromOtherUser = tc => {
  const { users, map0, map1, testConnector } = init$1(tc, { users: 3 });
  /**
   * @type {Object<string,any>}
   */
  let event = {};
  map0.observe(e => {
    event = e;
  });
  map1.set('stuff', 2);
  testConnector.flushAllMessages();
  t__namespace.compare(event.value, event.target.get(event.name));
  compare$1(users);
};

/**
 * @type {Array<function(Doc,prng.PRNG):void>}
 */
const mapTransactions = [
  function set (user, gen) {
    const key = prng__namespace.oneOf(gen, ['one', 'two']);
    const value = prng__namespace.utf16String(gen);
    user.getMap('map').set(key, value);
  },
  function setType (user, gen) {
    const key = prng__namespace.oneOf(gen, ['one', 'two']);
    const type = prng__namespace.oneOf(gen, [new YArray(), new YMap()]);
    user.getMap('map').set(key, type);
    if (type instanceof YArray) {
      type.insert(0, [1, 2, 3, 4]);
    } else {
      type.set('deepkey', 'deepvalue');
    }
  },
  function _delete (user, gen) {
    const key = prng__namespace.oneOf(gen, ['one', 'two']);
    user.getMap('map').delete(key);
  }
];

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests10 = tc => {
  applyRandomTests(tc, mapTransactions, 3);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests40 = tc => {
  applyRandomTests(tc, mapTransactions, 40);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests42 = tc => {
  applyRandomTests(tc, mapTransactions, 42);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests43 = tc => {
  applyRandomTests(tc, mapTransactions, 43);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests44 = tc => {
  applyRandomTests(tc, mapTransactions, 44);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests45 = tc => {
  applyRandomTests(tc, mapTransactions, 45);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests46 = tc => {
  applyRandomTests(tc, mapTransactions, 46);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests300 = tc => {
  applyRandomTests(tc, mapTransactions, 300);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests400 = tc => {
  applyRandomTests(tc, mapTransactions, 400);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests500 = tc => {
  applyRandomTests(tc, mapTransactions, 500);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests600 = tc => {
  applyRandomTests(tc, mapTransactions, 600);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests1000 = tc => {
  applyRandomTests(tc, mapTransactions, 1000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests1800 = tc => {
  applyRandomTests(tc, mapTransactions, 1800);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests5000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, mapTransactions, 5000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests10000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, mapTransactions, 10000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYmapTests100000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, mapTransactions, 100000);
};

var map = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testBasicMapTests: testBasicMapTests,
  testChangeEvent: testChangeEvent$1,
  testGetAndSetAndDeleteOfMapProperty: testGetAndSetAndDeleteOfMapProperty,
  testGetAndSetAndDeleteOfMapPropertyWithThreeConflicts: testGetAndSetAndDeleteOfMapPropertyWithThreeConflicts,
  testGetAndSetOfMapProperty: testGetAndSetOfMapProperty,
  testGetAndSetOfMapPropertySyncs: testGetAndSetOfMapPropertySyncs,
  testGetAndSetOfMapPropertyWithConflict: testGetAndSetOfMapPropertyWithConflict,
  testGetAndSetOfMapPropertyWithThreeConflicts: testGetAndSetOfMapPropertyWithThreeConflicts,
  testIterators: testIterators,
  testMapEventError: testMapEventError,
  testMapHavingIterableAsConstructorParamTests: testMapHavingIterableAsConstructorParamTests,
  testObserveDeepProperties: testObserveDeepProperties,
  testObserversUsingObservedeep: testObserversUsingObservedeep,
  testPathsOfSiblingEvents: testPathsOfSiblingEvents,
  testRepeatGeneratingYmapTests10: testRepeatGeneratingYmapTests10,
  testRepeatGeneratingYmapTests1000: testRepeatGeneratingYmapTests1000,
  testRepeatGeneratingYmapTests10000: testRepeatGeneratingYmapTests10000,
  testRepeatGeneratingYmapTests100000: testRepeatGeneratingYmapTests100000,
  testRepeatGeneratingYmapTests1800: testRepeatGeneratingYmapTests1800,
  testRepeatGeneratingYmapTests300: testRepeatGeneratingYmapTests300,
  testRepeatGeneratingYmapTests40: testRepeatGeneratingYmapTests40,
  testRepeatGeneratingYmapTests400: testRepeatGeneratingYmapTests400,
  testRepeatGeneratingYmapTests42: testRepeatGeneratingYmapTests42,
  testRepeatGeneratingYmapTests43: testRepeatGeneratingYmapTests43,
  testRepeatGeneratingYmapTests44: testRepeatGeneratingYmapTests44,
  testRepeatGeneratingYmapTests45: testRepeatGeneratingYmapTests45,
  testRepeatGeneratingYmapTests46: testRepeatGeneratingYmapTests46,
  testRepeatGeneratingYmapTests500: testRepeatGeneratingYmapTests500,
  testRepeatGeneratingYmapTests5000: testRepeatGeneratingYmapTests5000,
  testRepeatGeneratingYmapTests600: testRepeatGeneratingYmapTests600,
  testSetAndClearOfMapProperties: testSetAndClearOfMapProperties,
  testSetAndClearOfMapPropertiesWithConflicts: testSetAndClearOfMapPropertiesWithConflicts,
  testSizeAndDeleteOfMapProperty: testSizeAndDeleteOfMapProperty,
  testThrowsAddAndUpdateAndDeleteEvents: testThrowsAddAndUpdateAndDeleteEvents,
  testThrowsDeleteEventsOnClear: testThrowsDeleteEventsOnClear,
  testYmapEventExceptionsShouldCompleteTransaction: testYmapEventExceptionsShouldCompleteTransaction,
  testYmapEventHasCorrectValueWhenSettingAPrimitive: testYmapEventHasCorrectValueWhenSettingAPrimitive,
  testYmapEventHasCorrectValueWhenSettingAPrimitiveFromOtherUser: testYmapEventHasCorrectValueWhenSettingAPrimitiveFromOtherUser,
  testYmapSetsYarray: testYmapSetsYarray,
  testYmapSetsYmap: testYmapSetsYmap
});

/**
 * @param {t.TestCase} tc
 */
const testBasicUpdate = tc => {
  const doc1 = new Doc();
  const doc2 = new Doc();
  doc1.getArray('array').insert(0, ['hi']);
  const update = encodeStateAsUpdate(doc1);
  applyUpdate(doc2, update);
  t__namespace.compare(doc2.getArray('array').toArray(), ['hi']);
};

/**
 * @param {t.TestCase} tc
 */
const testSlice = tc => {
  const doc1 = new Doc();
  const arr = doc1.getArray('array');
  arr.insert(0, [1, 2, 3]);
  t__namespace.compareArrays(arr.slice(0), [1, 2, 3]);
  t__namespace.compareArrays(arr.slice(1), [2, 3]);
  t__namespace.compareArrays(arr.slice(0, -1), [1, 2]);
  arr.insert(0, [0]);
  t__namespace.compareArrays(arr.slice(0), [0, 1, 2, 3]);
  t__namespace.compareArrays(arr.slice(0, 2), [0, 1]);
};

/**
 * @param {t.TestCase} tc
 */
const testArrayFrom = tc => {
  const doc1 = new Doc();
  const db1 = doc1.getMap('root');
  const nestedArray1 = YArray.from([0, 1, 2]);
  db1.set('array', nestedArray1);
  t__namespace.compare(nestedArray1.toArray(), [0, 1, 2]);
};

/**
 * Debugging yjs#297 - a critical bug connected to the search-marker approach
 *
 * @param {t.TestCase} tc
 */
const testLengthIssue = tc => {
  const doc1 = new Doc();
  const arr = doc1.getArray('array');
  arr.push([0, 1, 2, 3]);
  arr.delete(0);
  arr.insert(0, [0]);
  t__namespace.assert(arr.length === arr.toArray().length);
  doc1.transact(() => {
    arr.delete(1);
    t__namespace.assert(arr.length === arr.toArray().length);
    arr.insert(1, [1]);
    t__namespace.assert(arr.length === arr.toArray().length);
    arr.delete(2);
    t__namespace.assert(arr.length === arr.toArray().length);
    arr.insert(2, [2]);
    t__namespace.assert(arr.length === arr.toArray().length);
  });
  t__namespace.assert(arr.length === arr.toArray().length);
  arr.delete(1);
  t__namespace.assert(arr.length === arr.toArray().length);
  arr.insert(1, [1]);
  t__namespace.assert(arr.length === arr.toArray().length);
};

/**
 * Debugging yjs#314
 *
 * @param {t.TestCase} tc
 */
const testLengthIssue2 = tc => {
  const doc = new Doc();
  const next = doc.getArray();
  doc.transact(() => {
    next.insert(0, ['group2']);
  });
  doc.transact(() => {
    next.insert(1, ['rectangle3']);
  });
  doc.transact(() => {
    next.delete(0);
    next.insert(0, ['rectangle3']);
  });
  next.delete(1);
  doc.transact(() => {
    next.insert(1, ['ellipse4']);
  });
  doc.transact(() => {
    next.insert(2, ['ellipse3']);
  });
  doc.transact(() => {
    next.insert(3, ['ellipse2']);
  });
  doc.transact(() => {
    doc.transact(() => {
      t__namespace.fails(() => {
        next.insert(5, ['rectangle2']);
      });
      next.insert(4, ['rectangle2']);
    });
    doc.transact(() => {
      // this should not throw an error message
      next.delete(4);
    });
  });
  console.log(next.toArray());
};

/**
 * @param {t.TestCase} tc
 */
const testDeleteInsert = tc => {
  const { users, array0 } = init$1(tc, { users: 2 });
  array0.delete(0, 0);
  t__namespace.describe('Does not throw when deleting zero elements with position 0');
  t__namespace.fails(() => {
    array0.delete(1, 1);
  });
  array0.insert(0, ['A']);
  array0.delete(1, 0);
  t__namespace.describe('Does not throw when deleting zero elements with valid position 1');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertThreeElementsTryRegetProperty = tc => {
  const { testConnector, users, array0, array1 } = init$1(tc, { users: 2 });
  array0.insert(0, [1, true, false]);
  t__namespace.compare(array0.toJSON(), [1, true, false], '.toJSON() works');
  testConnector.flushAllMessages();
  t__namespace.compare(array1.toJSON(), [1, true, false], '.toJSON() works after sync');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testConcurrentInsertWithThreeConflicts = tc => {
  const { users, array0, array1, array2 } = init$1(tc, { users: 3 });
  array0.insert(0, [0]);
  array1.insert(0, [1]);
  array2.insert(0, [2]);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testConcurrentInsertDeleteWithThreeConflicts = tc => {
  const { testConnector, users, array0, array1, array2 } = init$1(tc, { users: 3 });
  array0.insert(0, ['x', 'y', 'z']);
  testConnector.flushAllMessages();
  array0.insert(1, [0]);
  array1.delete(0);
  array1.delete(1, 1);
  array2.insert(1, [2]);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertionsInLateSync = tc => {
  const { testConnector, users, array0, array1, array2 } = init$1(tc, { users: 3 });
  array0.insert(0, ['x', 'y']);
  testConnector.flushAllMessages();
  users[1].disconnect();
  users[2].disconnect();
  array0.insert(1, ['user0']);
  array1.insert(1, ['user1']);
  array2.insert(1, ['user2']);
  users[1].connect();
  users[2].connect();
  testConnector.flushAllMessages();
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testDisconnectReallyPreventsSendingMessages = tc => {
  const { testConnector, users, array0, array1 } = init$1(tc, { users: 3 });
  array0.insert(0, ['x', 'y']);
  testConnector.flushAllMessages();
  users[1].disconnect();
  users[2].disconnect();
  array0.insert(1, ['user0']);
  array1.insert(1, ['user1']);
  t__namespace.compare(array0.toJSON(), ['x', 'user0', 'y']);
  t__namespace.compare(array1.toJSON(), ['x', 'user1', 'y']);
  users[1].connect();
  users[2].connect();
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testDeletionsInLateSync = tc => {
  const { testConnector, users, array0, array1 } = init$1(tc, { users: 2 });
  array0.insert(0, ['x', 'y']);
  testConnector.flushAllMessages();
  users[1].disconnect();
  array1.delete(1, 1);
  array0.delete(0, 2);
  users[1].connect();
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertThenMergeDeleteOnSync = tc => {
  const { testConnector, users, array0, array1 } = init$1(tc, { users: 2 });
  array0.insert(0, ['x', 'y', 'z']);
  testConnector.flushAllMessages();
  users[0].disconnect();
  array1.delete(0, 3);
  users[0].connect();
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertAndDeleteEvents = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {Object<string,any>?}
   */
  let event = null;
  array0.observe(e => {
    event = e;
  });
  array0.insert(0, [0, 1, 2]);
  t__namespace.assert(event !== null);
  event = null;
  array0.delete(0);
  t__namespace.assert(event !== null);
  event = null;
  array0.delete(0, 2);
  t__namespace.assert(event !== null);
  event = null;
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testNestedObserverEvents = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {Array<number>}
   */
  const vals = [];
  array0.observe(e => {
    if (array0.length === 1) {
      // inserting, will call this observer again
      // we expect that this observer is called after this event handler finishedn
      array0.insert(1, [1]);
      vals.push(0);
    } else {
      // this should be called the second time an element is inserted (above case)
      vals.push(1);
    }
  });
  array0.insert(0, [0]);
  t__namespace.compareArrays(vals, [0, 1]);
  t__namespace.compareArrays(array0.toArray(), [0, 1]);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertAndDeleteEventsForTypes = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {Object<string,any>|null}
   */
  let event = null;
  array0.observe(e => {
    event = e;
  });
  array0.insert(0, [new YArray()]);
  t__namespace.assert(event !== null);
  event = null;
  array0.delete(0);
  t__namespace.assert(event !== null);
  event = null;
  compare$1(users);
};

/**
 * This issue has been reported in https://discuss.yjs.dev/t/order-in-which-events-yielded-by-observedeep-should-be-applied/261/2
 *
 * Deep observers generate multiple events. When an array added at item at, say, position 0,
 * and item 1 changed then the array-add event should fire first so that the change event
 * path is correct. A array binding might lead to an inconsistent state otherwise.
 *
 * @param {t.TestCase} tc
 */
const testObserveDeepEventOrder = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {Array<any>}
   */
  let events = [];
  array0.observeDeep(e => {
    events = e;
  });
  array0.insert(0, [new YMap()]);
  users[0].transact(() => {
    array0.get(0).set('a', 'a');
    array0.insert(0, [0]);
  });
  for (let i = 1; i < events.length; i++) {
    t__namespace.assert(events[i - 1].path.length <= events[i].path.length, 'path size increases, fire top-level events first');
  }
};

/**
 * Correct index when computing event.path in observeDeep - https://github.com/yjs/yjs/issues/457
 *
 * @param {t.TestCase} _tc
 */
const testObservedeepIndexes = _tc => {
  const doc = new Doc();
  const map = doc.getMap();
  // Create a field with the array as value
  map.set('my-array', new YArray());
  // Fill the array with some strings and our Map
  map.get('my-array').push(['a', 'b', 'c', new YMap()]);
  /**
   * @type {Array<any>}
   */
  let eventPath = [];
  map.observeDeep((events) => { eventPath = events[0].path; });
  // set a value on the map inside of our array
  map.get('my-array').get(3).set('hello', 'world');
  console.log(eventPath);
  t__namespace.compare(eventPath, ['my-array', 3]);
};

/**
 * @param {t.TestCase} tc
 */
const testChangeEvent = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {any}
   */
  let changes = null;
  array0.observe(e => {
    changes = e.changes;
  });
  const newArr = new YArray();
  array0.insert(0, [newArr, 4, 'dtrn']);
  t__namespace.assert(changes !== null && changes.added.size === 2 && changes.deleted.size === 0);
  t__namespace.compare(changes.delta, [{ insert: [newArr, 4, 'dtrn'] }]);
  changes = null;
  array0.delete(0, 2);
  t__namespace.assert(changes !== null && changes.added.size === 0 && changes.deleted.size === 2);
  t__namespace.compare(changes.delta, [{ delete: 2 }]);
  changes = null;
  array0.insert(1, [0.1]);
  t__namespace.assert(changes !== null && changes.added.size === 1 && changes.deleted.size === 0);
  t__namespace.compare(changes.delta, [{ retain: 1 }, { insert: [0.1] }]);
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertAndDeleteEventsForTypes2 = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  /**
   * @type {Array<Object<string,any>>}
   */
  const events = [];
  array0.observe(e => {
    events.push(e);
  });
  array0.insert(0, ['hi', new YMap()]);
  t__namespace.assert(events.length === 1, 'Event is triggered exactly once for insertion of two elements');
  array0.delete(1);
  t__namespace.assert(events.length === 2, 'Event is triggered exactly once for deletion');
  compare$1(users);
};

/**
 * This issue has been reported here https://github.com/yjs/yjs/issues/155
 * @param {t.TestCase} tc
 */
const testNewChildDoesNotEmitEventInTransaction = tc => {
  const { array0, users } = init$1(tc, { users: 2 });
  let fired = false;
  users[0].transact(() => {
    const newMap = new YMap();
    newMap.observe(() => {
      fired = true;
    });
    array0.insert(0, [newMap]);
    newMap.set('tst', 42);
  });
  t__namespace.assert(!fired, 'Event does not trigger');
};

/**
 * @param {t.TestCase} tc
 */
const testGarbageCollector = tc => {
  const { testConnector, users, array0 } = init$1(tc, { users: 3 });
  array0.insert(0, ['x', 'y', 'z']);
  testConnector.flushAllMessages();
  users[0].disconnect();
  array0.delete(0, 3);
  users[0].connect();
  testConnector.flushAllMessages();
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testEventTargetIsSetCorrectlyOnLocal = tc => {
  const { array0, users } = init$1(tc, { users: 3 });
  /**
   * @type {any}
   */
  let event;
  array0.observe(e => {
    event = e;
  });
  array0.insert(0, ['stuff']);
  t__namespace.assert(event.target === array0, '"target" property is set correctly');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testEventTargetIsSetCorrectlyOnRemote = tc => {
  const { testConnector, array0, array1, users } = init$1(tc, { users: 3 });
  /**
   * @type {any}
   */
  let event;
  array0.observe(e => {
    event = e;
  });
  array1.insert(0, ['stuff']);
  testConnector.flushAllMessages();
  t__namespace.assert(event.target === array0, '"target" property is set correctly');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testIteratingArrayContainingTypes = tc => {
  const y = new Doc();
  const arr = y.getArray('arr');
  const numItems = 10;
  for (let i = 0; i < numItems; i++) {
    const map = new YMap();
    map.set('value', i);
    arr.push([map]);
  }
  let cnt = 0;
  for (const item of arr) {
    t__namespace.assert(item.get('value') === cnt++, 'value is correct');
  }
  y.destroy();
};

let _uniqueNumber = 0;
const getUniqueNumber = () => _uniqueNumber++;

/**
 * @type {Array<function(Doc,prng.PRNG,any):void>}
 */
const arrayTransactions = [
  function insert (user, gen) {
    const yarray = user.getArray('array');
    const uniqueNumber = getUniqueNumber();
    const content = [];
    const len = prng__namespace.int32(gen, 1, 4);
    for (let i = 0; i < len; i++) {
      content.push(uniqueNumber);
    }
    const pos = prng__namespace.int32(gen, 0, yarray.length);
    const oldContent = yarray.toArray();
    yarray.insert(pos, content);
    oldContent.splice(pos, 0, ...content);
    t__namespace.compareArrays(yarray.toArray(), oldContent); // we want to make sure that fastSearch markers insert at the correct position
  },
  function insertTypeArray (user, gen) {
    const yarray = user.getArray('array');
    const pos = prng__namespace.int32(gen, 0, yarray.length);
    yarray.insert(pos, [new YArray()]);
    const array2 = yarray.get(pos);
    array2.insert(0, [1, 2, 3, 4]);
  },
  function insertTypeMap (user, gen) {
    const yarray = user.getArray('array');
    const pos = prng__namespace.int32(gen, 0, yarray.length);
    yarray.insert(pos, [new YMap()]);
    const map = yarray.get(pos);
    map.set('someprop', 42);
    map.set('someprop', 43);
    map.set('someprop', 44);
  },
  function insertTypeNull (user, gen) {
    const yarray = user.getArray('array');
    const pos = prng__namespace.int32(gen, 0, yarray.length);
    yarray.insert(pos, [null]);
  },
  function _delete (user, gen) {
    const yarray = user.getArray('array');
    const length = yarray.length;
    if (length > 0) {
      let somePos = prng__namespace.int32(gen, 0, length - 1);
      let delLength = prng__namespace.int32(gen, 1, math__namespace.min(2, length - somePos));
      if (prng__namespace.bool(gen)) {
        const type = yarray.get(somePos);
        if (type instanceof YArray && type.length > 0) {
          somePos = prng__namespace.int32(gen, 0, type.length - 1);
          delLength = prng__namespace.int32(gen, 0, math__namespace.min(2, type.length - somePos));
          type.delete(somePos, delLength);
        }
      } else {
        const oldContent = yarray.toArray();
        yarray.delete(somePos, delLength);
        oldContent.splice(somePos, delLength);
        t__namespace.compareArrays(yarray.toArray(), oldContent);
      }
    }
  }
];

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests6 = tc => {
  applyRandomTests(tc, arrayTransactions, 6);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests40 = tc => {
  applyRandomTests(tc, arrayTransactions, 40);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests42 = tc => {
  applyRandomTests(tc, arrayTransactions, 42);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests43 = tc => {
  applyRandomTests(tc, arrayTransactions, 43);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests44 = tc => {
  applyRandomTests(tc, arrayTransactions, 44);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests45 = tc => {
  applyRandomTests(tc, arrayTransactions, 45);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests46 = tc => {
  applyRandomTests(tc, arrayTransactions, 46);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests300 = tc => {
  applyRandomTests(tc, arrayTransactions, 300);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests400 = tc => {
  applyRandomTests(tc, arrayTransactions, 400);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests500 = tc => {
  applyRandomTests(tc, arrayTransactions, 500);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests600 = tc => {
  applyRandomTests(tc, arrayTransactions, 600);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests1000 = tc => {
  applyRandomTests(tc, arrayTransactions, 1000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests1800 = tc => {
  applyRandomTests(tc, arrayTransactions, 1800);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests3000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, arrayTransactions, 3000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests5000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, arrayTransactions, 5000);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGeneratingYarrayTests30000 = tc => {
  t__namespace.skip(!t__namespace.production);
  applyRandomTests(tc, arrayTransactions, 30000);
};

var array = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testArrayFrom: testArrayFrom,
  testBasicUpdate: testBasicUpdate,
  testChangeEvent: testChangeEvent,
  testConcurrentInsertDeleteWithThreeConflicts: testConcurrentInsertDeleteWithThreeConflicts,
  testConcurrentInsertWithThreeConflicts: testConcurrentInsertWithThreeConflicts,
  testDeleteInsert: testDeleteInsert,
  testDeletionsInLateSync: testDeletionsInLateSync,
  testDisconnectReallyPreventsSendingMessages: testDisconnectReallyPreventsSendingMessages,
  testEventTargetIsSetCorrectlyOnLocal: testEventTargetIsSetCorrectlyOnLocal,
  testEventTargetIsSetCorrectlyOnRemote: testEventTargetIsSetCorrectlyOnRemote,
  testGarbageCollector: testGarbageCollector,
  testInsertAndDeleteEvents: testInsertAndDeleteEvents,
  testInsertAndDeleteEventsForTypes: testInsertAndDeleteEventsForTypes,
  testInsertAndDeleteEventsForTypes2: testInsertAndDeleteEventsForTypes2,
  testInsertThenMergeDeleteOnSync: testInsertThenMergeDeleteOnSync,
  testInsertThreeElementsTryRegetProperty: testInsertThreeElementsTryRegetProperty,
  testInsertionsInLateSync: testInsertionsInLateSync,
  testIteratingArrayContainingTypes: testIteratingArrayContainingTypes,
  testLengthIssue: testLengthIssue,
  testLengthIssue2: testLengthIssue2,
  testNestedObserverEvents: testNestedObserverEvents,
  testNewChildDoesNotEmitEventInTransaction: testNewChildDoesNotEmitEventInTransaction,
  testObserveDeepEventOrder: testObserveDeepEventOrder,
  testObservedeepIndexes: testObservedeepIndexes,
  testRepeatGeneratingYarrayTests1000: testRepeatGeneratingYarrayTests1000,
  testRepeatGeneratingYarrayTests1800: testRepeatGeneratingYarrayTests1800,
  testRepeatGeneratingYarrayTests300: testRepeatGeneratingYarrayTests300,
  testRepeatGeneratingYarrayTests3000: testRepeatGeneratingYarrayTests3000,
  testRepeatGeneratingYarrayTests30000: testRepeatGeneratingYarrayTests30000,
  testRepeatGeneratingYarrayTests40: testRepeatGeneratingYarrayTests40,
  testRepeatGeneratingYarrayTests400: testRepeatGeneratingYarrayTests400,
  testRepeatGeneratingYarrayTests42: testRepeatGeneratingYarrayTests42,
  testRepeatGeneratingYarrayTests43: testRepeatGeneratingYarrayTests43,
  testRepeatGeneratingYarrayTests44: testRepeatGeneratingYarrayTests44,
  testRepeatGeneratingYarrayTests45: testRepeatGeneratingYarrayTests45,
  testRepeatGeneratingYarrayTests46: testRepeatGeneratingYarrayTests46,
  testRepeatGeneratingYarrayTests500: testRepeatGeneratingYarrayTests500,
  testRepeatGeneratingYarrayTests5000: testRepeatGeneratingYarrayTests5000,
  testRepeatGeneratingYarrayTests6: testRepeatGeneratingYarrayTests6,
  testRepeatGeneratingYarrayTests600: testRepeatGeneratingYarrayTests600,
  testSlice: testSlice
});

const { init, compare } = Y;

/**
 * https://github.com/yjs/yjs/issues/474
 * @todo Remove debug: 127.0.0.1:8080/test.html?filter=\[88/
 * @param {t.TestCase} _tc
 */
const testDeltaBug = _tc => {
  const initialDelta = [{
    attributes: {
      'block-id': 'block-28eea923-9cbb-4b6f-a950-cf7fd82bc087'
    },
    insert: '\n'
  },
  {
    attributes: {
      'table-col': {
        width: '150'
      }
    },
    insert: '\n\n\n'
  },
  {
    attributes: {
      'block-id': 'block-9144be72-e528-4f91-b0b2-82d20408e9ea',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-6kv2ls',
        cell: 'cell-apba4k'
      },
      row: 'row-6kv2ls',
      cell: 'cell-apba4k',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-639adacb-1516-43ed-b272-937c55669a1c',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-6kv2ls',
        cell: 'cell-a8qf0r'
      },
      row: 'row-6kv2ls',
      cell: 'cell-a8qf0r',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-6302ca4a-73a3-4c25-8c1e-b542f048f1c6',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-6kv2ls',
        cell: 'cell-oi9ikb'
      },
      row: 'row-6kv2ls',
      cell: 'cell-oi9ikb',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-ceeddd05-330e-4f86-8017-4a3a060c4627',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-d1sv2g',
        cell: 'cell-dt6ks2'
      },
      row: 'row-d1sv2g',
      cell: 'cell-dt6ks2',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-37b19322-cb57-4e6f-8fad-0d1401cae53f',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-d1sv2g',
        cell: 'cell-qah2ay'
      },
      row: 'row-d1sv2g',
      cell: 'cell-qah2ay',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-468a69b5-9332-450b-9107-381d593de249',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-d1sv2g',
        cell: 'cell-fpcz5a'
      },
      row: 'row-d1sv2g',
      cell: 'cell-fpcz5a',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-26b1d252-9b2e-4808-9b29-04e76696aa3c',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-pflz90',
        cell: 'cell-zrhylp'
      },
      row: 'row-pflz90',
      cell: 'cell-zrhylp',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-6af97ba7-8cf9-497a-9365-7075b938837b',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-pflz90',
        cell: 'cell-s1q9nt'
      },
      row: 'row-pflz90',
      cell: 'cell-s1q9nt',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-107e273e-86bc-44fd-b0d7-41ab55aca484',
      'table-cell-line': {
        rowspan: '1',
        colspan: '1',
        row: 'row-pflz90',
        cell: 'cell-20b0j9'
      },
      row: 'row-pflz90',
      cell: 'cell-20b0j9',
      rowspan: '1',
      colspan: '1'
    },
    insert: '\n'
  },
  {
    attributes: {
      'block-id': 'block-38161f9c-6f6d-44c5-b086-54cc6490f1e3'
    },
    insert: '\n'
  },
  {
    insert: 'Content after table'
  },
  {
    attributes: {
      'block-id': 'block-15630542-ef45-412d-9415-88f0052238ce'
    },
    insert: '\n'
  }
  ];
  const ydoc1 = new Doc();
  const ytext = ydoc1.getText();
  ytext.applyDelta(initialDelta);
  const addingDash = [
    {
      retain: 12
    },
    {
      insert: '-'
    }
  ];
  ytext.applyDelta(addingDash);
  const addingSpace = [
    {
      retain: 13
    },
    {
      insert: ' '
    }
  ];
  ytext.applyDelta(addingSpace);
  const addingList = [
    {
      retain: 12
    },
    {
      delete: 2
    },
    {
      retain: 1,
      attributes: {
        // Clear table line attribute
        'table-cell-line': null,
        // Add list attribute in place of table-cell-line
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-pflz90',
          cell: 'cell-20b0j9',
          list: 'bullet'
        }
      }
    }
  ];
  ytext.applyDelta(addingList);
  const result = ytext.toDelta();
  const expectedResult = [
    {
      attributes: {
        'block-id': 'block-28eea923-9cbb-4b6f-a950-cf7fd82bc087'
      },
      insert: '\n'
    },
    {
      attributes: {
        'table-col': {
          width: '150'
        }
      },
      insert: '\n\n\n'
    },
    {
      attributes: {
        'block-id': 'block-9144be72-e528-4f91-b0b2-82d20408e9ea',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-6kv2ls',
          cell: 'cell-apba4k'
        },
        row: 'row-6kv2ls',
        cell: 'cell-apba4k',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-639adacb-1516-43ed-b272-937c55669a1c',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-6kv2ls',
          cell: 'cell-a8qf0r'
        },
        row: 'row-6kv2ls',
        cell: 'cell-a8qf0r',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-6302ca4a-73a3-4c25-8c1e-b542f048f1c6',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-6kv2ls',
          cell: 'cell-oi9ikb'
        },
        row: 'row-6kv2ls',
        cell: 'cell-oi9ikb',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-ceeddd05-330e-4f86-8017-4a3a060c4627',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-d1sv2g',
          cell: 'cell-dt6ks2'
        },
        row: 'row-d1sv2g',
        cell: 'cell-dt6ks2',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-37b19322-cb57-4e6f-8fad-0d1401cae53f',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-d1sv2g',
          cell: 'cell-qah2ay'
        },
        row: 'row-d1sv2g',
        cell: 'cell-qah2ay',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-468a69b5-9332-450b-9107-381d593de249',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-d1sv2g',
          cell: 'cell-fpcz5a'
        },
        row: 'row-d1sv2g',
        cell: 'cell-fpcz5a',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-26b1d252-9b2e-4808-9b29-04e76696aa3c',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-pflz90',
          cell: 'cell-zrhylp'
        },
        row: 'row-pflz90',
        cell: 'cell-zrhylp',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      attributes: {
        'block-id': 'block-6af97ba7-8cf9-497a-9365-7075b938837b',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-pflz90',
          cell: 'cell-s1q9nt'
        },
        row: 'row-pflz90',
        cell: 'cell-s1q9nt',
        rowspan: '1',
        colspan: '1'
      },
      insert: '\n'
    },
    {
      insert: '\n',
      // This attibutes has only list and no table-cell-line
      attributes: {
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-pflz90',
          cell: 'cell-20b0j9',
          list: 'bullet'
        },
        'block-id': 'block-107e273e-86bc-44fd-b0d7-41ab55aca484',
        row: 'row-pflz90',
        cell: 'cell-20b0j9',
        rowspan: '1',
        colspan: '1'
      }
    },
    // No table-cell-line below here
    {
      attributes: {
        'block-id': 'block-38161f9c-6f6d-44c5-b086-54cc6490f1e3'
      },
      insert: '\n'
    },
    {
      insert: 'Content after table'
    },
    {
      attributes: {
        'block-id': 'block-15630542-ef45-412d-9415-88f0052238ce'
      },
      insert: '\n'
    }
  ];
  t__namespace.compare(result, expectedResult);
};

/**
 * https://github.com/yjs/yjs/issues/503
 * @param {t.TestCase} _tc
 */
const testDeltaBug2 = _tc => {
  const initialContent = [
    { insert: "Thomas' section" },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-61ae80ac-a469-4eae-bac9-3b6a2c380118' }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-d265d93f-1cc7-40ee-bb58-8270fca2619f' }
    },
    { insert: '123' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-592a7bee-76a3-4e28-9c25-7a84344f8813',
        list: { list: 'toggled', 'toggle-id': 'list-66xfft' }
      }
    },
    { insert: '456' },
    {
      insert: '\n',
      attributes: {
        indent: 1,
        'block-id': 'block-3ee2bd70-b97f-45b2-9115-f1e8910235b1',
        list: { list: 'toggled', 'toggle-id': 'list-6vh0t0' }
      }
    },
    { insert: '789' },
    {
      insert: '\n',
      attributes: {
        indent: 1,
        'block-id': 'block-78150cf3-9bb5-4dea-a6f5-0ce1d2a98b9c',
        list: { list: 'toggled', 'toggle-id': 'list-7jr0l2' }
      }
    },
    { insert: '901' },
    {
      insert: '\n',
      attributes: {
        indent: 1,
        'block-id': 'block-13c6416f-f522-41d5-9fd4-ce4eb1cde5ba',
        list: { list: 'toggled', 'toggle-id': 'list-7uk8qu' }
      }
    },
    {
      insert: {
        slash_command: {
          id: 'doc_94zq-2436',
          sessionId: 'nkwc70p2j',
          replace: '/'
        }
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-8a1d2bb6-23c2-4bcf-af3c-3919ffea1697' }
    },
    { insert: '\n\n', attributes: { 'table-col': { width: '150' } } },
    {
      insert: '\n',
      attributes: { 'table-col': { width: '150' } }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-84ec3ea4-da6a-4e03-b430-0e5f432936a9',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-blmd4s',
          cell: 'cell-m0u5za'
        },
        row: 'row-blmd4s',
        cell: 'cell-m0u5za',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-83144ca8-aace-401e-8aa5-c05928a8ccf0',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-blmd4s',
          cell: 'cell-1v8s8t'
        },
        row: 'row-blmd4s',
        cell: 'cell-1v8s8t',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-9a493387-d27f-4b58-b2f7-731dfafda32a',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-blmd4s',
          cell: 'cell-126947'
        },
        row: 'row-blmd4s',
        cell: 'cell-126947',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-3484f86e-ae42-440f-8de6-857f0d8011ea',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-hmmljo',
          cell: 'cell-wvutl9'
        },
        row: 'row-hmmljo',
        cell: 'cell-wvutl9',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d4e0b741-9dea-47a5-85e1-4ded0efbc89d',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-hmmljo',
          cell: 'cell-nkablr'
        },
        row: 'row-hmmljo',
        cell: 'cell-nkablr',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-352f0d5a-d1b9-422f-b136-4bacefd00b1a',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-hmmljo',
          cell: 'cell-n8xtd0'
        },
        row: 'row-hmmljo',
        cell: 'cell-n8xtd0',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-95823e57-f29c-44cf-a69d-2b4494b7144b',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ev4xwq',
          cell: 'cell-ua9bvu'
        },
        row: 'row-ev4xwq',
        cell: 'cell-ua9bvu',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-cde5c027-15d3-4780-9e76-1e1a9d97a8e8',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ev4xwq',
          cell: 'cell-7bwuvk'
        },
        row: 'row-ev4xwq',
        cell: 'cell-7bwuvk',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-11a23ed4-b04d-4e45-8065-8120889cd4a4',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ev4xwq',
          cell: 'cell-aouka5'
        },
        row: 'row-ev4xwq',
        cell: 'cell-aouka5',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-15b4483c-da98-4ded-91d3-c3d6ebc82582' }
    },
    { insert: { divider: true } },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-68552c8e-b57b-4f4a-9f36-6cc1ef6b3461' }
    },
    { insert: 'jklasjdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-c8b2df7d-8ec5-4dd4-81f1-8d8efc40b1b4',
        list: { list: 'toggled', 'toggle-id': 'list-9ss39s' }
      }
    },
    { insert: 'asdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4f252ceb-14da-49ae-8cbd-69a701d18e2a',
        list: { list: 'toggled', 'toggle-id': 'list-uvo013' }
      }
    },
    { insert: 'adg' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-ccb9b72e-b94d-45a0-aae4-9b0a1961c533',
        list: { list: 'toggled', 'toggle-id': 'list-k53iwe' }
      }
    },
    { insert: 'asdfasdfasdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-ccb9b72e-b94d-45a0-aae4-9b0a1961c533',
        list: { list: 'none' },
        indent: 1
      }
    },
    { insert: 'asdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-f406f76d-f338-4261-abe7-5c9131f7f1ad',
        list: { list: 'toggled', 'toggle-id': 'list-en86ur' }
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-be18141c-9b6b-434e-8fd0-2c214437d560' }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-36922db3-4af5-48a1-9ea4-0788b3b5d7cf' }
    },
    { insert: { table_content: true } },
    { insert: ' ' },
    {
      insert: {
        slash_command: {
          id: 'doc_94zq-2436',
          sessionId: 'hiyrt6fny',
          replace: '/'
        }
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-9d6566a1-be55-4e20-999a-b990bc15e143' }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4b545085-114d-4d07-844c-789710ec3aab',
        layout:
        '12d887e1-d1a2-4814-a1a3-0c904e950b46_1185cd29-ef1b-45d5-8fda-51a70b704e64',
        'layout-width': '0.25'
      }
    },
    {
      insert: '\n',
      attributes: {

        'block-id': 'block-4d3f2321-33d1-470e-9b7c-d5a683570148',
        layout:
        '12d887e1-d1a2-4814-a1a3-0c904e950b46_75523ea3-c67f-4f5f-a85f-ac7c8fc0a992',
        'layout-width': '0.5'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4c7ae1e6-758e-470f-8d7c-ae0325e4ee8a',
        layout:
        '12d887e1-d1a2-4814-a1a3-0c904e950b46_54c740ef-fd7b-48c6-85aa-c14e1bfc9297',
        'layout-width': '0.25'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-2d6ff0f4-ff00-42b7-a8e2-b816463d8fb5' }
    },
    { insert: { divider: true } },
    {
      insert: '\n',
      attributes: { 'table-col': { width: '150' } }
    },
    { insert: '\n', attributes: { 'table-col': { width: '154' } } },
    {
      insert: '\n',
      attributes: { 'table-col': { width: '150' } }
    },

    {
      insert: '\n',
      attributes: {
        'block-id': 'block-38545d56-224b-464c-b779-51fcec24dbbf',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-q0qfck',
          cell: 'cell-hmapv4'
        },
        row: 'row-q0qfck',
        cell: 'cell-hmapv4',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d413a094-5f52-4fd4-a4aa-00774f6fdb44',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-q0qfck',
          cell: 'cell-c0czb2'
        },
        row: 'row-q0qfck',
        cell: 'cell-c0czb2',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-ff855cbc-8871-4e0a-9ba7-de0c1c2aa585',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-q0qfck',
          cell: 'cell-hcpqmm'
        },
        row: 'row-q0qfck',
        cell: 'cell-hcpqmm',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4841e6ee-fef8-4473-bf04-f5ba62db17f0',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-etopyl',
          cell: 'cell-0io73v'
        },
        row: 'row-etopyl',
        cell: 'cell-0io73v',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-adeec631-d4fe-4f38-9d5e-e67ba068bd24',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-etopyl',
          cell: 'cell-gt2waa'
        },
        row: 'row-etopyl',
        cell: 'cell-gt2waa',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d38a7308-c858-4ce0-b1f3-0f9092384961',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-etopyl',
          cell: 'cell-os9ksy'
        },
        row: 'row-etopyl',
        cell: 'cell-os9ksy',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-a9df6568-1838-40d1-9d16-3c073b6ce169',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-hbx9ri'
        },
        row: 'row-0jwjg3',
        cell: 'cell-hbx9ri',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-e26a0cf2-fe62-44a5-a4ca-8678a56d62f1',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-yg5m2w'
        },
        row: 'row-0jwjg3',
        cell: 'cell-yg5m2w',
        rowspan: '1',
        colspan: '1'
      }
    },
    { insert: 'a' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-bfbc5ac2-7417-44b9-9aa5-8e36e4095627',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'b' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-f011c089-6389-47c0-8396-7477a29aa56f',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'c' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4497788d-1e02-4fd5-a80a-48b61a6185cb',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'd' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-5d73a2c7-f98b-47c7-a3f5-0d8527962b02',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'e' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-bfda76ee-ffdd-45db-a22e-a6707e11cf68',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'd' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-35242e64-a69d-4cdb-bd85-2a93766bfab4',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    { insert: 'f' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-8baa22c8-491b-4f1b-9502-44179d5ae744',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-0jwjg3',
          cell: 'cell-1azhl2',
          list: 'ordered'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-0jwjg3',
        cell: 'cell-1azhl2'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-7fa64af0-6974-4205-8cee-529f8bd46852' }
    },
    { insert: { divider: true } },
    { insert: "Brandon's Section" },
    {
      insert: '\n',
      attributes: {
        header: 2,
        'block-id': 'block-cf49462c-2370-48ff-969d-576cb32c39a1'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-30ef8361-0dd6-4eee-b4eb-c9012d0e9070' }
    },
    {
      insert: {
        slash_command: {
          id: 'doc_94zq-2436',
          sessionId: 'x9x08o916',
          replace: '/'
        }
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-166ed856-cf8c-486a-9365-f499b21d91b3' }
    },
    { insert: { divider: true } },
    {
      insert: '\n',
      attributes: {
        row: 'row-kssn15',
        rowspan: '1',
        colspan: '1',
        'block-id': 'block-e8079594-4559-4259-98bb-da5280e2a692',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-kssn15',
          cell: 'cell-qxbksf'
        },
        cell: 'cell-qxbksf'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-70132663-14cc-4701-b5c5-eb99e875e2bd',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-kssn15',
          cell: 'cell-lsohbx'
        },
        cell: 'cell-lsohbx',
        row: 'row-kssn15',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-47a3899c-e3c5-4a7a-a8c4-46e0ae73a4fa',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-kssn15',
          cell: 'cell-hner9k'
        },
        cell: 'cell-hner9k',
        row: 'row-kssn15',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-0f9e650a-7841-412e-b4f2-5571b6d352c2',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-juxwc0',
          cell: 'cell-ei4yqp'
        },
        cell: 'cell-ei4yqp',
        row: 'row-juxwc0',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-53a158a9-8c82-4c82-9d4e-f5298257ca43',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-juxwc0',
          cell: 'cell-25pf5x'
        },
        cell: 'cell-25pf5x',
        row: 'row-juxwc0',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-da8ba35e-ce6e-4518-8605-c51d781eb07a',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-juxwc0',
          cell: 'cell-m8reor'
        },
        cell: 'cell-m8reor',
        row: 'row-juxwc0',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-2dce37c7-2978-4127-bed0-9549781babcb',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ot4wy5',
          cell: 'cell-dinh0i'
        },
        cell: 'cell-dinh0i',
        row: 'row-ot4wy5',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-7b593f8c-4ea3-44b4-8ad9-4a0abffe759b',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ot4wy5',
          cell: 'cell-d115b2'
        },
        cell: 'cell-d115b2',
        row: 'row-ot4wy5',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-272c28e6-2bde-4477-9d99-ce35b3045895',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-ot4wy5',
          cell: 'cell-fuapvo'
        },
        cell: 'cell-fuapvo',
        row: 'row-ot4wy5',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-fbf23cab-1ce9-4ede-9953-f2f8250004cf' }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-c3fbb8c9-495c-40b0-b0dd-f6e33dd64b1b' }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-3417ad09-92a3-4a43-b5db-6dbcb0f16db4' }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-b9eacdce-4ba3-4e66-8b69-3eace5656057' }
    },
    { insert: 'Dan Gornstein' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d7c6ae0d-a17c-433e-85fd-5efc52b587fb',
        header: 1
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-814521bd-0e14-4fbf-b332-799c6452a624' }
    },
    { insert: 'aaa' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-6aaf4dcf-dc21-45c6-b723-afb25fe0f498',
        list: { list: 'toggled', 'toggle-id': 'list-idl93b' }
      }
    },
    { insert: 'bb' },
    {
      insert: '\n',
      attributes: {
        indent: 1,
        'block-id': 'block-3dd75392-fa50-4bfb-ba6b-3b7d6bd3f1a1',
        list: { list: 'toggled', 'toggle-id': 'list-mrq7j2' }
      }
    },
    { insert: 'ccc' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-2528578b-ecda-4f74-9fd7-8741d72dc8b3',
        indent: 2,
        list: { list: 'toggled', 'toggle-id': 'list-liu7dl' }
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-18bf68c3-9ef3-4874-929c-9b6bb1a00325' }
    },
    {
      insert: '\n',
      attributes: { 'table-col': { width: '150' } }
    },
    { insert: '\n', attributes: { 'table-col': { width: '150' } } },
    {
      insert: '\n',
      attributes: { 'table-col': { width: '150' } }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d44e74b4-b37f-48e0-b319-6327a6295a57',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-cpybie'
        },
        row: 'row-si1nah',
        cell: 'cell-cpybie',
        rowspan: '1',
        colspan: '1'
      }
    },
    { insert: 'aaa' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-3e545ee9-0c9a-42d7-a4d0-833edb8087f3',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-cpybie',
          list: 'toggled',
          'toggle-id': 'list-kjl2ik'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-si1nah',
        cell: 'cell-cpybie'
      }
    },
    { insert: 'bb' },
    {
      insert: '\n',
      attributes: {
        indent: 1,
        'block-id': 'block-5f1225ad-370f-46ab-8f1e-18b277b5095f',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-cpybie',
          list: 'toggled',
          'toggle-id': 'list-eei1x5'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-si1nah',
        cell: 'cell-cpybie'
      }
    },
    { insert: 'ccc' },
    {
      insert: '\n',
      attributes: {
        indent: 2,
        'block-id': 'block-a77fdc11-ad24-431b-9ca2-09e32db94ac2',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-cpybie',
          list: 'toggled',
          'toggle-id': 'list-30us3c'
        },
        rowspan: '1',
        colspan: '1',
        row: 'row-si1nah',
        cell: 'cell-cpybie'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d44e74b4-b37f-48e0-b319-6327a6295a57',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-cpybie'
        },
        row: 'row-si1nah',
        cell: 'cell-cpybie',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-2c274c8a-757d-4892-8db8-1a7999f7ab51',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-al1z64'
        },
        row: 'row-si1nah',
        cell: 'cell-al1z64',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-85931afe-1879-471c-bb4b-89e7bd517fe9',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-si1nah',
          cell: 'cell-q186pb'
        },
        row: 'row-si1nah',
        cell: 'cell-q186pb',
        rowspan: '1',
        colspan: '1'
      }
    },
    { insert: 'asdfasdfasdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-6e0522e8-c1eb-4c07-98df-2b07c533a139',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-7x2d1o',
          cell: 'cell-6eid2t'
        },
        row: 'row-7x2d1o',
        cell: 'cell-6eid2t',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-4b3d0bd0-9175-45e9-955c-e8164f4b5376',
        row: 'row-7x2d1o',
        cell: 'cell-m1alad',
        rowspan: '1',
        colspan: '1',
        list: {
          rowspan: '1',
          colspan: '1',
          row: 'row-7x2d1o',
          cell: 'cell-m1alad',
          list: 'ordered'
        }
      }
    },
    { insert: 'asdfasdfasdf' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-08610089-cb05-4366-bb1e-a0787d5b11bf',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-7x2d1o',
          cell: 'cell-dm1l2p'
        },
        row: 'row-7x2d1o',
        cell: 'cell-dm1l2p',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-c22b5125-8df3-432f-bd55-5ff456e41b4e',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-o0ujua',
          cell: 'cell-82g0ca'
        },
        row: 'row-o0ujua',
        cell: 'cell-82g0ca',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-7c6320e4-acaf-4ab4-8355-c9b00408c9c1',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-o0ujua',
          cell: 'cell-wv6ozp'
        },
        row: 'row-o0ujua',
        cell: 'cell-wv6ozp',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-d1bb7bed-e69e-4807-8d20-2d28fef8d08f',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-o0ujua',
          cell: 'cell-ldt53x'
        },
        row: 'row-o0ujua',
        cell: 'cell-ldt53x',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-28f28cb8-51a2-4156-acf9-2380e1349745' }
    },
    { insert: { divider: true } },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-a1193252-c0c8-47fe-b9f6-32c8b01a1619' }
    },
    { insert: '\n', attributes: { 'table-col': { width: '150' } } },
    {
      insert: '\n\n',
      attributes: { 'table-col': { width: '150' } }
    },
    { insert: '/This is a test.' },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-14188df0-a63f-4317-9a6d-91b96a7ac9fe',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5ixdvv',
          cell: 'cell-9tgyed'
        },
        row: 'row-5ixdvv',
        cell: 'cell-9tgyed',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-7e5ba2af-9903-457d-adf4-2a79be81d823',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5ixdvv',
          cell: 'cell-xc56e9'
        },
        row: 'row-5ixdvv',
        cell: 'cell-xc56e9',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-eb6cad93-caf7-4848-8adf-415255139268',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5ixdvv',
          cell: 'cell-xrze3u'
        },
        row: 'row-5ixdvv',
        cell: 'cell-xrze3u',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-5bb547a2-6f71-4624-80c7-d0e1318c81a2',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-xbzv98',
          cell: 'cell-lie0ng'
        },
        row: 'row-xbzv98',
        cell: 'cell-lie0ng',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-b506de0d-efb6-4bd7-ba8e-2186cc57903e',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-xbzv98',
          cell: 'cell-s9sow1'
        },
        row: 'row-xbzv98',
        cell: 'cell-s9sow1',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-42d2ad20-5521-40e3-a88d-fe6906176e61',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-xbzv98',
          cell: 'cell-nodtcj'
        },
        row: 'row-xbzv98',
        cell: 'cell-nodtcj',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-7d3e4216-3f68-4dd6-bc77-4a9fad4ba008',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5bqfil',
          cell: 'cell-c8c0f3'
        },
        row: 'row-5bqfil',
        cell: 'cell-c8c0f3',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-6671f221-551e-47fb-9b7d-9043b6b12cdc',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5bqfil',
          cell: 'cell-jvxxif'
        },
        row: 'row-5bqfil',
        cell: 'cell-jvxxif',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: {
        'block-id': 'block-51e3161b-0437-4fe3-ac4f-129a93a93fc3',
        'table-cell-line': {
          rowspan: '1',
          colspan: '1',
          row: 'row-5bqfil',
          cell: 'cell-rmjpze'
        },
        row: 'row-5bqfil',
        cell: 'cell-rmjpze',
        rowspan: '1',
        colspan: '1'
      }
    },
    {
      insert: '\n',
      attributes: { 'block-id': 'block-21099df0-afb2-4cd3-834d-bb37800eb06a' }
    }
  ];
  const ydoc = new Doc();
  const ytext = ydoc.getText('id');
  ytext.applyDelta(initialContent);
  const changeEvent = [
    { retain: 90 },
    { delete: 4 },
    {
      retain: 1,
      attributes: {
        layout: null,
        'layout-width': null,
        'block-id': 'block-9d6566a1-be55-4e20-999a-b990bc15e143'
      }
    }
  ];
  ytext.applyDelta(changeEvent);
  const delta = ytext.toDelta();
  t__namespace.compare(delta[41], {
    insert: '\n',
    attributes: {
      'block-id': 'block-9d6566a1-be55-4e20-999a-b990bc15e143'
    }
  });
};

/**
 * In this test we are mainly interested in the cleanup behavior and whether the resulting delta makes sense.
 * It is fine if the resulting delta is not minimal. But applying the delta to a rich-text editor should result in a
 * synced document.
 *
 * @param {t.TestCase} tc
 */
const testDeltaAfterConcurrentFormatting = tc => {
  const { text0, text1, testConnector } = init(tc, { users: 2 });
  text0.insert(0, 'abcde');
  testConnector.flushAllMessages();
  text0.format(0, 3, { bold: true });
  text1.format(2, 2, { bold: true });
  /**
   * @type {any}
   */
  const deltas = [];
  text1.observe(event => {
    if (event.delta.length > 0) {
      deltas.push(event.delta);
    }
  });
  testConnector.flushAllMessages();
  t__namespace.compare(deltas, [[{ retain: 3, attributes: { bold: true } }, { retain: 2, attributes: { bold: null } }]]);
};

/**
 * @param {t.TestCase} tc
 */
const testBasicInsertAndDelete = tc => {
  const { users, text0 } = init(tc, { users: 2 });
  let delta;

  text0.observe(event => {
    delta = event.delta;
  });

  text0.delete(0, 0);
  t__namespace.assert(true, 'Does not throw when deleting zero elements with position 0');

  text0.insert(0, 'abc');
  t__namespace.assert(text0.toString() === 'abc', 'Basic insert works');
  t__namespace.compare(delta, [{ insert: 'abc' }]);

  text0.delete(0, 1);
  t__namespace.assert(text0.toString() === 'bc', 'Basic delete works (position 0)');
  t__namespace.compare(delta, [{ delete: 1 }]);

  text0.delete(1, 1);
  t__namespace.assert(text0.toString() === 'b', 'Basic delete works (position 1)');
  t__namespace.compare(delta, [{ retain: 1 }, { delete: 1 }]);

  users[0].transact(() => {
    text0.insert(0, '1');
    text0.delete(0, 1);
  });
  t__namespace.compare(delta, []);

  compare(users);
};

/**
 * @param {t.TestCase} tc
 */
const testBasicFormat = tc => {
  const { users, text0 } = init(tc, { users: 2 });
  let delta;
  text0.observe(event => {
    delta = event.delta;
  });
  text0.insert(0, 'abc', { bold: true });
  t__namespace.assert(text0.toString() === 'abc', 'Basic insert with attributes works');
  t__namespace.compare(text0.toDelta(), [{ insert: 'abc', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ insert: 'abc', attributes: { bold: true } }]);
  text0.delete(0, 1);
  t__namespace.assert(text0.toString() === 'bc', 'Basic delete on formatted works (position 0)');
  t__namespace.compare(text0.toDelta(), [{ insert: 'bc', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ delete: 1 }]);
  text0.delete(1, 1);
  t__namespace.assert(text0.toString() === 'b', 'Basic delete works (position 1)');
  t__namespace.compare(text0.toDelta(), [{ insert: 'b', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ retain: 1 }, { delete: 1 }]);
  text0.insert(0, 'z', { bold: true });
  t__namespace.assert(text0.toString() === 'zb');
  t__namespace.compare(text0.toDelta(), [{ insert: 'zb', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ insert: 'z', attributes: { bold: true } }]);
  // @ts-ignore
  t__namespace.assert(text0._start.right.right.right.content.str === 'b', 'Does not insert duplicate attribute marker');
  text0.insert(0, 'y');
  t__namespace.assert(text0.toString() === 'yzb');
  t__namespace.compare(text0.toDelta(), [{ insert: 'y' }, { insert: 'zb', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ insert: 'y' }]);
  text0.format(0, 2, { bold: null });
  t__namespace.assert(text0.toString() === 'yzb');
  t__namespace.compare(text0.toDelta(), [{ insert: 'yz' }, { insert: 'b', attributes: { bold: true } }]);
  t__namespace.compare(delta, [{ retain: 1 }, { retain: 1, attributes: { bold: null } }]);
  compare(users);
};

/**
 * @param {t.TestCase} tc
 */
const testFalsyFormats = tc => {
  const { users, text0 } = init(tc, { users: 2 });
  let delta;
  text0.observe(event => {
    delta = event.delta;
  });
  text0.insert(0, 'abcde', { falsy: false });
  t__namespace.compare(text0.toDelta(), [{ insert: 'abcde', attributes: { falsy: false } }]);
  t__namespace.compare(delta, [{ insert: 'abcde', attributes: { falsy: false } }]);
  text0.format(1, 3, { falsy: true });
  t__namespace.compare(text0.toDelta(), [{ insert: 'a', attributes: { falsy: false } }, { insert: 'bcd', attributes: { falsy: true } }, { insert: 'e', attributes: { falsy: false } }]);
  t__namespace.compare(delta, [{ retain: 1 }, { retain: 3, attributes: { falsy: true } }]);
  text0.format(2, 1, { falsy: false });
  t__namespace.compare(text0.toDelta(), [{ insert: 'a', attributes: { falsy: false } }, { insert: 'b', attributes: { falsy: true } }, { insert: 'c', attributes: { falsy: false } }, { insert: 'd', attributes: { falsy: true } }, { insert: 'e', attributes: { falsy: false } }]);
  t__namespace.compare(delta, [{ retain: 2 }, { retain: 1, attributes: { falsy: false } }]);
  compare(users);
};

/**
 * @param {t.TestCase} _tc
 */
const testMultilineFormat = _tc => {
  const ydoc = new Doc();
  const testText = ydoc.getText('test');
  testText.insert(0, 'Test\nMulti-line\nFormatting');
  testText.applyDelta([
    { retain: 4, attributes: { bold: true } },
    { retain: 1 }, // newline character
    { retain: 10, attributes: { bold: true } },
    { retain: 1 }, // newline character
    { retain: 10, attributes: { bold: true } }
  ]);
  t__namespace.compare(testText.toDelta(), [
    { insert: 'Test', attributes: { bold: true } },
    { insert: '\n' },
    { insert: 'Multi-line', attributes: { bold: true } },
    { insert: '\n' },
    { insert: 'Formatting', attributes: { bold: true } }
  ]);
};

/**
 * @param {t.TestCase} _tc
 */
const testNotMergeEmptyLinesFormat = _tc => {
  const ydoc = new Doc();
  const testText = ydoc.getText('test');
  testText.applyDelta([
    { insert: 'Text' },
    { insert: '\n', attributes: { title: true } },
    { insert: '\nText' },
    { insert: '\n', attributes: { title: true } }
  ]);
  t__namespace.compare(testText.toDelta(), [
    { insert: 'Text' },
    { insert: '\n', attributes: { title: true } },
    { insert: '\nText' },
    { insert: '\n', attributes: { title: true } }
  ]);
};

/**
 * @param {t.TestCase} _tc
 */
const testPreserveAttributesThroughDelete = _tc => {
  const ydoc = new Doc();
  const testText = ydoc.getText('test');
  testText.applyDelta([
    { insert: 'Text' },
    { insert: '\n', attributes: { title: true } },
    { insert: '\n' }
  ]);
  testText.applyDelta([
    { retain: 4 },
    { delete: 1 },
    { retain: 1, attributes: { title: true } }
  ]);
  t__namespace.compare(testText.toDelta(), [
    { insert: 'Text' },
    { insert: '\n', attributes: { title: true } }
  ]);
};

/**
 * @param {t.TestCase} tc
 */
const testGetDeltaWithEmbeds = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.applyDelta([{
    insert: { linebreak: 's' }
  }]);
  t__namespace.compare(text0.toDelta(), [{
    insert: { linebreak: 's' }
  }]);
};

/**
 * @param {t.TestCase} tc
 */
const testTypesAsEmbed = tc => {
  const { text0, text1, testConnector } = init(tc, { users: 2 });
  text0.applyDelta([{
    insert: new YMap([['key', 'val']])
  }]);
  t__namespace.compare(text0.toDelta()[0].insert.toJSON(), { key: 'val' });
  let firedEvent = false;
  text1.observe(event => {
    const d = event.delta;
    t__namespace.assert(d.length === 1);
    t__namespace.compare(d.map(x => /** @type {Y.AbstractType<any>} */ (x.insert).toJSON()), [{ key: 'val' }]);
    firedEvent = true;
  });
  testConnector.flushAllMessages();
  const delta = text1.toDelta();
  t__namespace.assert(delta.length === 1);
  t__namespace.compare(delta[0].insert.toJSON(), { key: 'val' });
  t__namespace.assert(firedEvent, 'fired the event observer containing a Type-Embed');
};

/**
 * @param {t.TestCase} tc
 */
const testSnapshot = tc => {
  const { text0 } = init(tc, { users: 1 });
  const doc0 = /** @type {Y.Doc} */ (text0.doc);
  doc0.gc = false;
  text0.applyDelta([{
    insert: 'abcd'
  }]);
  const snapshot1 = snapshot$1(doc0);
  text0.applyDelta([{
    retain: 1
  }, {
    insert: 'x'
  }, {
    delete: 1
  }]);
  const snapshot2 = snapshot$1(doc0);
  text0.applyDelta([{
    retain: 2
  }, {
    delete: 3
  }, {
    insert: 'x'
  }, {
    delete: 1
  }]);
  const state1 = text0.toDelta(snapshot1);
  t__namespace.compare(state1, [{ insert: 'abcd' }]);
  const state2 = text0.toDelta(snapshot2);
  t__namespace.compare(state2, [{ insert: 'axcd' }]);
  const state2Diff = text0.toDelta(snapshot2, snapshot1);
  // @ts-ignore Remove userid info
  state2Diff.forEach(v => {
    if (v.attributes && v.attributes.ychange) {
      delete v.attributes.ychange.user;
    }
  });
  t__namespace.compare(state2Diff, [{ insert: 'a' }, { insert: 'x', attributes: { ychange: { type: 'added' } } }, { insert: 'b', attributes: { ychange: { type: 'removed' } } }, { insert: 'cd' }]);
};

/**
 * @param {t.TestCase} tc
 */
const testSnapshotDeleteAfter = tc => {
  const { text0 } = init(tc, { users: 1 });
  const doc0 = /** @type {Y.Doc} */ (text0.doc);
  doc0.gc = false;
  text0.applyDelta([{
    insert: 'abcd'
  }]);
  const snapshot1 = snapshot$1(doc0);
  text0.applyDelta([{
    retain: 4
  }, {
    insert: 'e'
  }]);
  const state1 = text0.toDelta(snapshot1);
  t__namespace.compare(state1, [{ insert: 'abcd' }]);
};

/**
 * @param {t.TestCase} tc
 */
const testToJson = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.insert(0, 'abc', { bold: true });
  t__namespace.assert(text0.toJSON() === 'abc', 'toJSON returns the unformatted text');
};

/**
 * @param {t.TestCase} tc
 */
const testToDeltaEmbedAttributes = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.insert(0, 'ab', { bold: true });
  text0.insertEmbed(1, { image: 'imageSrc.png' }, { width: 100 });
  const delta0 = text0.toDelta();
  t__namespace.compare(delta0, [{ insert: 'a', attributes: { bold: true } }, { insert: { image: 'imageSrc.png' }, attributes: { width: 100 } }, { insert: 'b', attributes: { bold: true } }]);
};

/**
 * @param {t.TestCase} tc
 */
const testToDeltaEmbedNoAttributes = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.insert(0, 'ab', { bold: true });
  text0.insertEmbed(1, { image: 'imageSrc.png' });
  const delta0 = text0.toDelta();
  t__namespace.compare(delta0, [{ insert: 'a', attributes: { bold: true } }, { insert: { image: 'imageSrc.png' } }, { insert: 'b', attributes: { bold: true } }], 'toDelta does not set attributes key when no attributes are present');
};

/**
 * @param {t.TestCase} tc
 */
const testFormattingRemoved = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.insert(0, 'ab', { bold: true });
  text0.delete(0, 2);
  t__namespace.assert(getTypeChildren(text0).length === 1);
};

/**
 * @param {t.TestCase} tc
 */
const testFormattingRemovedInMidText = tc => {
  const { text0 } = init(tc, { users: 1 });
  text0.insert(0, '1234');
  text0.insert(2, 'ab', { bold: true });
  text0.delete(2, 2);
  t__namespace.assert(getTypeChildren(text0).length === 3);
};

/**
 * Reported in https://github.com/yjs/yjs/issues/344
 *
 * @param {t.TestCase} tc
 */
const testFormattingDeltaUnnecessaryAttributeChange = tc => {
  const { text0, text1, testConnector } = init(tc, { users: 2 });
  text0.insert(0, '\n', {
    PARAGRAPH_STYLES: 'normal',
    LIST_STYLES: 'bullet'
  });
  text0.insert(1, 'abc', {
    PARAGRAPH_STYLES: 'normal'
  });
  testConnector.flushAllMessages();
  /**
   * @type {Array<any>}
   */
  const deltas = [];
  text0.observe(event => {
    deltas.push(event.delta);
  });
  text1.observe(event => {
    deltas.push(event.delta);
  });
  text1.format(0, 1, { LIST_STYLES: 'number' });
  testConnector.flushAllMessages();
  const filteredDeltas = deltas.filter(d => d.length > 0);
  t__namespace.assert(filteredDeltas.length === 2);
  t__namespace.compare(filteredDeltas[0], [
    { retain: 1, attributes: { LIST_STYLES: 'number' } }
  ]);
  t__namespace.compare(filteredDeltas[0], filteredDeltas[1]);
};

/**
 * @param {t.TestCase} tc
 */
const testInsertAndDeleteAtRandomPositions = tc => {
  const N = 100000;
  const { text0 } = init(tc, { users: 1 });
  const gen = tc.prng;

  // create initial content
  // let expectedResult = init
  text0.insert(0, prng__namespace.word(gen, N / 2, N / 2));

  // apply changes
  for (let i = 0; i < N; i++) {
    const pos = prng__namespace.uint32(gen, 0, text0.length);
    if (prng__namespace.bool(gen)) {
      const len = prng__namespace.uint32(gen, 1, 5);
      const word = prng__namespace.word(gen, 0, len);
      text0.insert(pos, word);
      // expectedResult = expectedResult.slice(0, pos) + word + expectedResult.slice(pos)
    } else {
      const len = prng__namespace.uint32(gen, 0, math__namespace.min(3, text0.length - pos));
      text0.delete(pos, len);
      // expectedResult = expectedResult.slice(0, pos) + expectedResult.slice(pos + len)
    }
  }
  // t.compareStrings(text0.toString(), expectedResult)
  t__namespace.describe('final length', '' + text0.length);
};

/**
 * @param {t.TestCase} tc
 */
const testAppendChars = tc => {
  const N = 10000;
  const { text0 } = init(tc, { users: 1 });

  // apply changes
  for (let i = 0; i < N; i++) {
    text0.insert(text0.length, 'a');
  }
  t__namespace.assert(text0.length === N);
};

const largeDocumentSize = 100000;

const id = createID(0, 0);
const c = new ContentString('a');

/**
 * @param {t.TestCase} _tc
 */
const testBestCase = _tc => {
  const N = largeDocumentSize;
  const items = new Array(N);
  t__namespace.measureTime('time to create two million items in the best case', () => {
    const parent = /** @type {any} */ ({});
    let prevItem = null;
    for (let i = 0; i < N; i++) {
      /**
       * @type {Y.Item}
       */
      const n = new Item(createID(0, 0), null, null, null, null, null, null, c);
      // items.push(n)
      items[i] = n;
      n.right = prevItem;
      n.rightOrigin = prevItem ? id : null;
      n.content = c;
      n.parent = parent;
      prevItem = n;
    }
  });
  const newArray = new Array(N);
  t__namespace.measureTime('time to copy two million items to new Array', () => {
    for (let i = 0; i < N; i++) {
      newArray[i] = items[i];
    }
  });
};

const tryGc = () => {
  // @ts-ignore
  if (typeof global !== 'undefined' && global.gc) {
    // @ts-ignore
    global.gc();
  }
};

/**
 * @param {t.TestCase} _tc
 */
const testLargeFragmentedDocument = _tc => {
  const itemsToInsert = largeDocumentSize;
  let update = /** @type {any} */ (null)
  ;(() => {
    const doc1 = new Doc();
    const text0 = doc1.getText('txt');
    tryGc();
    t__namespace.measureTime(`time to insert ${itemsToInsert} items`, () => {
      doc1.transact(() => {
        for (let i = 0; i < itemsToInsert; i++) {
          text0.insert(0, '0');
        }
      });
    });
    tryGc();
    t__namespace.measureTime('time to encode document', () => {
      update = encodeStateAsUpdateV2(doc1);
    });
    t__namespace.describe('Document size:', update.byteLength);
  })()
  ;(() => {
    const doc2 = new Doc();
    tryGc();
    t__namespace.measureTime(`time to apply ${itemsToInsert} updates`, () => {
      applyUpdateV2(doc2, update);
    });
  })();
};

/**
 * @param {t.TestCase} _tc
 */
const testIncrementalUpdatesPerformanceOnLargeFragmentedDocument = _tc => {
  const itemsToInsert = largeDocumentSize;
  const updates = /** @type {Array<Uint8Array>} */ ([])
  ;(() => {
    const doc1 = new Doc();
    doc1.on('update', update => {
      updates.push(update);
    });
    const text0 = doc1.getText('txt');
    tryGc();
    t__namespace.measureTime(`time to insert ${itemsToInsert} items`, () => {
      doc1.transact(() => {
        for (let i = 0; i < itemsToInsert; i++) {
          text0.insert(0, '0');
        }
      });
    });
    tryGc();
  })()
  ;(() => {
    t__namespace.measureTime(`time to merge ${itemsToInsert} updates (differential updates)`, () => {
      mergeUpdates(updates);
    });
    tryGc();
    t__namespace.measureTime(`time to merge ${itemsToInsert} updates (ydoc updates)`, () => {
      const ydoc = new Doc();
      updates.forEach(update => {
        applyUpdate(ydoc, update);
      });
    });
  })();
};

/**
 * Splitting surrogates can lead to invalid encoded documents.
 *
 * https://github.com/yjs/yjs/issues/248
 *
 * @param {t.TestCase} tc
 */
const testSplitSurrogateCharacter = tc => {
  {
    const { users, text0 } = init(tc, { users: 2 });
    users[1].disconnect(); // disconnecting forces the user to encode the split surrogate
    text0.insert(0, '👾'); // insert surrogate character
    // split surrogate, which should not lead to an encoding error
    text0.insert(1, 'hi!');
    compare(users);
  }
  {
    const { users, text0 } = init(tc, { users: 2 });
    users[1].disconnect(); // disconnecting forces the user to encode the split surrogate
    text0.insert(0, '👾👾'); // insert surrogate character
    // partially delete surrogate
    text0.delete(1, 2);
    compare(users);
  }
  {
    const { users, text0 } = init(tc, { users: 2 });
    users[1].disconnect(); // disconnecting forces the user to encode the split surrogate
    text0.insert(0, '👾👾'); // insert surrogate character
    // formatting will also split surrogates
    text0.format(1, 2, { bold: true });
    compare(users);
  }
};

/**
 * Search marker bug https://github.com/yjs/yjs/issues/307
 *
 * @param {t.TestCase} tc
 */
const testSearchMarkerBug1 = tc => {
  const { users, text0, text1, testConnector } = init(tc, { users: 2 });

  users[0].on('update', update => {
    users[0].transact(() => {
      applyUpdate(users[0], update);
    });
  });
  users[0].on('update', update => {
    users[1].transact(() => {
      applyUpdate(users[1], update);
    });
  });

  text0.insert(0, 'a_a');
  testConnector.flushAllMessages();
  text0.insert(2, 's');
  testConnector.flushAllMessages();
  text1.insert(3, 'd');
  testConnector.flushAllMessages();
  text0.delete(0, 5);
  testConnector.flushAllMessages();
  text0.insert(0, 'a_a');
  testConnector.flushAllMessages();
  text0.insert(2, 's');
  testConnector.flushAllMessages();
  text1.insert(3, 'd');
  testConnector.flushAllMessages();
  t__namespace.compareStrings(text0.toString(), text1.toString());
  t__namespace.compareStrings(text0.toString(), 'a_sda');
  compare(users);
};

/**
 * Reported in https://github.com/yjs/yjs/pull/32
 *
 * @param {t.TestCase} _tc
 */
const testFormattingBug$1 = async _tc => {
  const ydoc1 = new Doc();
  const ydoc2 = new Doc();
  const text1 = ydoc1.getText();
  text1.insert(0, '\n\n\n');
  text1.format(0, 3, { url: 'http://example.com' });
  ydoc1.getText().format(1, 1, { url: 'http://docs.yjs.dev' });
  ydoc2.getText().format(1, 1, { url: 'http://docs.yjs.dev' });
  applyUpdate(ydoc2, encodeStateAsUpdate(ydoc1));
  const text2 = ydoc2.getText();
  const expectedResult = [
    { insert: '\n', attributes: { url: 'http://example.com' } },
    { insert: '\n', attributes: { url: 'http://docs.yjs.dev' } },
    { insert: '\n', attributes: { url: 'http://example.com' } }
  ];
  t__namespace.compare(text1.toDelta(), expectedResult);
  t__namespace.compare(text1.toDelta(), text2.toDelta());
  console.log(text1.toDelta());
};

/**
 * Delete formatting should not leave redundant formatting items.
 *
 * @param {t.TestCase} _tc
 */
const testDeleteFormatting = _tc => {
  const doc = new Doc();
  const text = doc.getText();
  text.insert(0, 'Attack ships on fire off the shoulder of Orion.');

  const doc2 = new Doc();
  const text2 = doc2.getText();
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  text.format(13, 7, { bold: true });
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  text.format(16, 4, { bold: null });
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  const expected = [
    { insert: 'Attack ships ' },
    { insert: 'on ', attributes: { bold: true } },
    { insert: 'fire off the shoulder of Orion.' }
  ];
  t__namespace.compare(text.toDelta(), expected);
  t__namespace.compare(text2.toDelta(), expected);
};

// RANDOM TESTS

let charCounter = 0;

/**
 * Random tests for pure text operations without formatting.
 *
 * @type Array<function(any,prng.PRNG):void>
 */
const textChanges = [
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // insert text
    const ytext = y.getText('text');
    const insertPos = prng__namespace.int32(gen, 0, ytext.length);
    const text = charCounter++ + prng__namespace.word(gen);
    const prevText = ytext.toString();
    ytext.insert(insertPos, text);
    t__namespace.compareStrings(ytext.toString(), prevText.slice(0, insertPos) + text + prevText.slice(insertPos));
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // delete text
    const ytext = y.getText('text');
    const contentLen = ytext.toString().length;
    const insertPos = prng__namespace.int32(gen, 0, contentLen);
    const overwrite = math__namespace.min(prng__namespace.int32(gen, 0, contentLen - insertPos), 2);
    const prevText = ytext.toString();
    ytext.delete(insertPos, overwrite);
    t__namespace.compareStrings(ytext.toString(), prevText.slice(0, insertPos) + prevText.slice(insertPos + overwrite));
  }
];

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges5 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 5));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges30 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 30));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges40 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 40));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges50 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 50));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges70 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 70));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges90 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 90));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateTextChanges300 = tc => {
  const { users } = checkResult(applyRandomTests(tc, textChanges, 300));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

const marks = [
  { bold: true },
  { italic: true },
  { italic: true, color: '#888' }
];

const marksChoices = [
  undefined,
  ...marks
];

/**
 * Random tests for all features of y-text (formatting, embeds, ..).
 *
 * @type Array<function(any,prng.PRNG):void>
 */
const qChanges = [
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // insert text
    const ytext = y.getText('text');
    const insertPos = prng__namespace.int32(gen, 0, ytext.length);
    const attrs = prng__namespace.oneOf(gen, marksChoices);
    const text = charCounter++ + prng__namespace.word(gen);
    ytext.insert(insertPos, text, attrs);
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // insert embed
    const ytext = y.getText('text');
    const insertPos = prng__namespace.int32(gen, 0, ytext.length);
    if (prng__namespace.bool(gen)) {
      ytext.insertEmbed(insertPos, { image: 'https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png' });
    } else {
      ytext.insertEmbed(insertPos, new YMap([[prng__namespace.word(gen), prng__namespace.word(gen)]]));
    }
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // delete text
    const ytext = y.getText('text');
    const contentLen = ytext.toString().length;
    const insertPos = prng__namespace.int32(gen, 0, contentLen);
    const overwrite = math__namespace.min(prng__namespace.int32(gen, 0, contentLen - insertPos), 2);
    ytext.delete(insertPos, overwrite);
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // format text
    const ytext = y.getText('text');
    const contentLen = ytext.toString().length;
    const insertPos = prng__namespace.int32(gen, 0, contentLen);
    const overwrite = math__namespace.min(prng__namespace.int32(gen, 0, contentLen - insertPos), 2);
    const format = prng__namespace.oneOf(gen, marks);
    ytext.format(insertPos, overwrite, format);
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // insert codeblock
    const ytext = y.getText('text');
    const insertPos = prng__namespace.int32(gen, 0, ytext.toString().length);
    const text = charCounter++ + prng__namespace.word(gen);
    const ops = [];
    if (insertPos > 0) {
      ops.push({ retain: insertPos });
    }
    ops.push({ insert: text }, { insert: '\n', format: { 'code-block': true } });
    ytext.applyDelta(ops);
  },
  /**
   * @param {Y.Doc} y
   * @param {prng.PRNG} gen
   */
  (y, gen) => { // complex delta op
    const ytext = y.getText('text');
    const contentLen = ytext.toString().length;
    let currentPos = math__namespace.max(0, prng__namespace.int32(gen, 0, contentLen - 1));
    /**
     * @type {Array<any>}
     */
    const ops = currentPos > 0 ? [{ retain: currentPos }] : [];
    // create max 3 ops
    for (let i = 0; i < 7 && currentPos < contentLen; i++) {
      prng__namespace.oneOf(gen, [
        () => { // format
          const retain = math__namespace.min(prng__namespace.int32(gen, 0, contentLen - currentPos), 5);
          const format = prng__namespace.oneOf(gen, marks);
          ops.push({ retain, attributes: format });
          currentPos += retain;
        },
        () => { // insert
          const attrs = prng__namespace.oneOf(gen, marksChoices);
          const text = prng__namespace.word(gen, 1, 3);
          ops.push({ insert: text, attributes: attrs });
        },
        () => { // delete
          const delLen = math__namespace.min(prng__namespace.int32(gen, 0, contentLen - currentPos), 10);
          ops.push({ delete: delLen });
          currentPos += delLen;
        }
      ])();
    }
    ytext.applyDelta(ops);
  }
];

/**
 * @param {any} result
 */
const checkResult = result => {
  for (let i = 1; i < result.testObjects.length; i++) {
    /**
     * @param {any} d
     */
    const typeToObject = d => d.insert instanceof AbstractType ? d.insert.toJSON() : d;
    const p1 = result.users[i].getText('text').toDelta().map(typeToObject);
    const p2 = result.users[i].getText('text').toDelta().map(typeToObject);
    t__namespace.compare(p1, p2);
  }
  // Uncomment this to find formatting-cleanup issues
  // const cleanups = Y.cleanupYTextFormatting(result.users[0].getText('text'))
  // t.assert(cleanups === 0)
  return result
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges1 = tc => {
  const { users } = checkResult(applyRandomTests(tc, qChanges, 1));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges2 = tc => {
  const { users } = checkResult(applyRandomTests(tc, qChanges, 2));
  const cleanups = cleanupYTextFormatting(users[0].getText('text'));
  t__namespace.assert(cleanups === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges2Repeat = tc => {
  for (let i = 0; i < 1000; i++) {
    const { users } = checkResult(applyRandomTests(tc, qChanges, 2));
    const cleanups = cleanupYTextFormatting(users[0].getText('text'));
    t__namespace.assert(cleanups === 0);
  }
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges3 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 3));
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges30 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 30));
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges40 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 40));
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges70 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 70));
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges100 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 100));
};

/**
 * @param {t.TestCase} tc
 */
const testRepeatGenerateQuillChanges300 = tc => {
  checkResult(applyRandomTests(tc, qChanges, 300));
};

var text = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testAppendChars: testAppendChars,
  testBasicFormat: testBasicFormat,
  testBasicInsertAndDelete: testBasicInsertAndDelete,
  testBestCase: testBestCase,
  testDeleteFormatting: testDeleteFormatting,
  testDeltaAfterConcurrentFormatting: testDeltaAfterConcurrentFormatting,
  testDeltaBug: testDeltaBug,
  testDeltaBug2: testDeltaBug2,
  testFalsyFormats: testFalsyFormats,
  testFormattingBug: testFormattingBug$1,
  testFormattingDeltaUnnecessaryAttributeChange: testFormattingDeltaUnnecessaryAttributeChange,
  testFormattingRemoved: testFormattingRemoved,
  testFormattingRemovedInMidText: testFormattingRemovedInMidText,
  testGetDeltaWithEmbeds: testGetDeltaWithEmbeds,
  testIncrementalUpdatesPerformanceOnLargeFragmentedDocument: testIncrementalUpdatesPerformanceOnLargeFragmentedDocument,
  testInsertAndDeleteAtRandomPositions: testInsertAndDeleteAtRandomPositions,
  testLargeFragmentedDocument: testLargeFragmentedDocument,
  testMultilineFormat: testMultilineFormat,
  testNotMergeEmptyLinesFormat: testNotMergeEmptyLinesFormat,
  testPreserveAttributesThroughDelete: testPreserveAttributesThroughDelete,
  testRepeatGenerateQuillChanges1: testRepeatGenerateQuillChanges1,
  testRepeatGenerateQuillChanges100: testRepeatGenerateQuillChanges100,
  testRepeatGenerateQuillChanges2: testRepeatGenerateQuillChanges2,
  testRepeatGenerateQuillChanges2Repeat: testRepeatGenerateQuillChanges2Repeat,
  testRepeatGenerateQuillChanges3: testRepeatGenerateQuillChanges3,
  testRepeatGenerateQuillChanges30: testRepeatGenerateQuillChanges30,
  testRepeatGenerateQuillChanges300: testRepeatGenerateQuillChanges300,
  testRepeatGenerateQuillChanges40: testRepeatGenerateQuillChanges40,
  testRepeatGenerateQuillChanges70: testRepeatGenerateQuillChanges70,
  testRepeatGenerateTextChanges30: testRepeatGenerateTextChanges30,
  testRepeatGenerateTextChanges300: testRepeatGenerateTextChanges300,
  testRepeatGenerateTextChanges40: testRepeatGenerateTextChanges40,
  testRepeatGenerateTextChanges5: testRepeatGenerateTextChanges5,
  testRepeatGenerateTextChanges50: testRepeatGenerateTextChanges50,
  testRepeatGenerateTextChanges70: testRepeatGenerateTextChanges70,
  testRepeatGenerateTextChanges90: testRepeatGenerateTextChanges90,
  testSearchMarkerBug1: testSearchMarkerBug1,
  testSnapshot: testSnapshot,
  testSnapshotDeleteAfter: testSnapshotDeleteAfter,
  testSplitSurrogateCharacter: testSplitSurrogateCharacter,
  testToDeltaEmbedAttributes: testToDeltaEmbedAttributes,
  testToDeltaEmbedNoAttributes: testToDeltaEmbedNoAttributes,
  testToJson: testToJson,
  testTypesAsEmbed: testTypesAsEmbed
});

const testCustomTypings = () => {
  const ydoc = new Doc();
  const ymap = ydoc.getMap();
  /**
   * @type {Y.XmlElement<{ num: number, str: string, [k:string]: object|number|string }>}
   */
  const yxml = ymap.set('yxml', new YXmlElement('test'));
  /**
   * @type {number|undefined}
   */
  const num = yxml.getAttribute('num');
  /**
   * @type {string|undefined}
   */
  const str = yxml.getAttribute('str');
  /**
   * @type {object|number|string|undefined}
   */
  const dtrn = yxml.getAttribute('dtrn');
  const attrs = yxml.getAttributes();
  /**
   * @type {object|number|string|undefined}
   */
  const any = attrs.shouldBeAny;
  console.log({ num, str, dtrn, attrs, any });
};

/**
 * @param {t.TestCase} tc
 */
const testSetProperty = tc => {
  const { testConnector, users, xml0, xml1 } = init$1(tc, { users: 2 });
  xml0.setAttribute('height', '10');
  t__namespace.assert(xml0.getAttribute('height') === '10', 'Simple set+get works');
  testConnector.flushAllMessages();
  t__namespace.assert(xml1.getAttribute('height') === '10', 'Simple set+get works (remote)');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testHasProperty = tc => {
  const { testConnector, users, xml0, xml1 } = init$1(tc, { users: 2 });
  xml0.setAttribute('height', '10');
  t__namespace.assert(xml0.hasAttribute('height'), 'Simple set+has works');
  testConnector.flushAllMessages();
  t__namespace.assert(xml1.hasAttribute('height'), 'Simple set+has works (remote)');

  xml0.removeAttribute('height');
  t__namespace.assert(!xml0.hasAttribute('height'), 'Simple set+remove+has works');
  testConnector.flushAllMessages();
  t__namespace.assert(!xml1.hasAttribute('height'), 'Simple set+remove+has works (remote)');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testEvents = tc => {
  const { testConnector, users, xml0, xml1 } = init$1(tc, { users: 2 });
  /**
   * @type {any}
   */
  let event;
  /**
   * @type {any}
   */
  let remoteEvent;
  xml0.observe(e => {
    event = e;
  });
  xml1.observe(e => {
    remoteEvent = e;
  });
  xml0.setAttribute('key', 'value');
  t__namespace.assert(event.attributesChanged.has('key'), 'YXmlEvent.attributesChanged on updated key');
  testConnector.flushAllMessages();
  t__namespace.assert(remoteEvent.attributesChanged.has('key'), 'YXmlEvent.attributesChanged on updated key (remote)');
  // check attributeRemoved
  xml0.removeAttribute('key');
  t__namespace.assert(event.attributesChanged.has('key'), 'YXmlEvent.attributesChanged on removed attribute');
  testConnector.flushAllMessages();
  t__namespace.assert(remoteEvent.attributesChanged.has('key'), 'YXmlEvent.attributesChanged on removed attribute (remote)');
  xml0.insert(0, [new YXmlText('some text')]);
  t__namespace.assert(event.childListChanged, 'YXmlEvent.childListChanged on inserted element');
  testConnector.flushAllMessages();
  t__namespace.assert(remoteEvent.childListChanged, 'YXmlEvent.childListChanged on inserted element (remote)');
  // test childRemoved
  xml0.delete(0);
  t__namespace.assert(event.childListChanged, 'YXmlEvent.childListChanged on deleted element');
  testConnector.flushAllMessages();
  t__namespace.assert(remoteEvent.childListChanged, 'YXmlEvent.childListChanged on deleted element (remote)');
  compare$1(users);
};

/**
 * @param {t.TestCase} tc
 */
const testTreewalker = tc => {
  const { users, xml0 } = init$1(tc, { users: 3 });
  const paragraph1 = new YXmlElement('p');
  const paragraph2 = new YXmlElement('p');
  const text1 = new YXmlText('init');
  const text2 = new YXmlText('text');
  paragraph1.insert(0, [text1, text2]);
  xml0.insert(0, [paragraph1, paragraph2, new YXmlElement('img')]);
  const allParagraphs = xml0.querySelectorAll('p');
  t__namespace.assert(allParagraphs.length === 2, 'found exactly two paragraphs');
  t__namespace.assert(allParagraphs[0] === paragraph1, 'querySelectorAll found paragraph1');
  t__namespace.assert(allParagraphs[1] === paragraph2, 'querySelectorAll found paragraph2');
  t__namespace.assert(xml0.querySelector('p') === paragraph1, 'querySelector found paragraph1');
  compare$1(users);
};

/**
 * @param {t.TestCase} _tc
 */
const testYtextAttributes = _tc => {
  const ydoc = new Doc();
  const ytext = /** @type {Y.XmlText} */ (ydoc.get('', YXmlText));
  ytext.observe(event => {
    t__namespace.compare(event.changes.keys.get('test'), { action: 'add', oldValue: undefined });
  });
  ytext.setAttribute('test', 42);
  t__namespace.compare(ytext.getAttribute('test'), 42);
  t__namespace.compare(ytext.getAttributes(), { test: 42 });
};

/**
 * @param {t.TestCase} _tc
 */
const testSiblings = _tc => {
  const ydoc = new Doc();
  const yxml = ydoc.getXmlFragment();
  const first = new YXmlText();
  const second = new YXmlElement('p');
  yxml.insert(0, [first, second]);
  t__namespace.assert(first.nextSibling === second);
  t__namespace.assert(second.prevSibling === first);
  t__namespace.assert(first.parent === yxml);
  t__namespace.assert(yxml.parent === null);
  t__namespace.assert(yxml.firstChild === first);
};

/**
 * @param {t.TestCase} _tc
 */
const testInsertafter = _tc => {
  const ydoc = new Doc();
  const yxml = ydoc.getXmlFragment();
  const first = new YXmlText();
  const second = new YXmlElement('p');
  const third = new YXmlElement('p');

  const deepsecond1 = new YXmlElement('span');
  const deepsecond2 = new YXmlText();
  second.insertAfter(null, [deepsecond1]);
  second.insertAfter(deepsecond1, [deepsecond2]);

  yxml.insertAfter(null, [first, second]);
  yxml.insertAfter(second, [third]);

  t__namespace.assert(yxml.length === 3);
  t__namespace.assert(second.get(0) === deepsecond1);
  t__namespace.assert(second.get(1) === deepsecond2);

  t__namespace.compareArrays(yxml.toArray(), [first, second, third]);

  t__namespace.fails(() => {
    const el = new YXmlElement('p');
    el.insertAfter(deepsecond1, [new YXmlText()]);
  });
};

/**
 * @param {t.TestCase} _tc
 */
const testClone = _tc => {
  const ydoc = new Doc();
  const yxml = ydoc.getXmlFragment();
  const first = new YXmlText('text');
  const second = new YXmlElement('p');
  const third = new YXmlElement('p');
  yxml.push([first, second, third]);
  t__namespace.compareArrays(yxml.toArray(), [first, second, third]);
  const cloneYxml = yxml.clone();
  ydoc.getArray('copyarr').insert(0, [cloneYxml]);
  t__namespace.assert(cloneYxml.length === 3);
  t__namespace.compare(cloneYxml.toJSON(), yxml.toJSON());
};

/**
 * @param {t.TestCase} _tc
 */
const testFormattingBug = _tc => {
  const ydoc = new Doc();
  const yxml = /** @type {Y.XmlText} */ (ydoc.get('', YXmlText));
  const delta = [
    { insert: 'A', attributes: { em: {}, strong: {} } },
    { insert: 'B', attributes: { em: {} } },
    { insert: 'C', attributes: { em: {}, strong: {} } }
  ];
  yxml.applyDelta(delta);
  t__namespace.compare(yxml.toDelta(), delta);
};

/**
 * @param {t.TestCase} _tc
 */
const testElement = _tc => {
  const ydoc = new Doc();
  const yxmlel = ydoc.getXmlElement();
  const text1 = new YXmlText('text1');
  const text2 = new YXmlText('text2');
  yxmlel.insert(0, [text1, text2]);
  t__namespace.compareArrays(yxmlel.toArray(), [text1, text2]);
};

var xml = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testClone: testClone,
  testCustomTypings: testCustomTypings,
  testElement: testElement,
  testEvents: testEvents,
  testFormattingBug: testFormattingBug,
  testHasProperty: testHasProperty,
  testInsertafter: testInsertafter,
  testSetProperty: testSetProperty,
  testSiblings: testSiblings,
  testTreewalker: testTreewalker,
  testYtextAttributes: testYtextAttributes
});

/**
 * @param {t.TestCase} tc
 */
const testStructReferences = tc => {
  t__namespace.assert(contentRefs.length === 11);
  t__namespace.assert(contentRefs[1] === readContentDeleted);
  t__namespace.assert(contentRefs[2] === readContentJSON); // TODO: deprecate content json?
  t__namespace.assert(contentRefs[3] === readContentBinary);
  t__namespace.assert(contentRefs[4] === readContentString);
  t__namespace.assert(contentRefs[5] === readContentEmbed);
  t__namespace.assert(contentRefs[6] === readContentFormat);
  t__namespace.assert(contentRefs[7] === readContentType);
  t__namespace.assert(contentRefs[8] === readContentAny);
  t__namespace.assert(contentRefs[9] === readContentDoc);
  // contentRefs[10] is reserved for Skip structs
};

/**
 * There is some custom encoding/decoding happening in PermanentUserData.
 * This is why it landed here.
 *
 * @param {t.TestCase} tc
 */
const testPermanentUserData = async tc => {
  const ydoc1 = new Doc();
  const ydoc2 = new Doc();
  const pd1 = new PermanentUserData(ydoc1);
  const pd2 = new PermanentUserData(ydoc2);
  pd1.setUserMapping(ydoc1, ydoc1.clientID, 'user a');
  pd2.setUserMapping(ydoc2, ydoc2.clientID, 'user b');
  ydoc1.getText().insert(0, 'xhi');
  ydoc1.getText().delete(0, 1);
  ydoc2.getText().insert(0, 'hxxi');
  ydoc2.getText().delete(1, 2);
  await promise__namespace.wait(10);
  applyUpdate(ydoc2, encodeStateAsUpdate(ydoc1));
  applyUpdate(ydoc1, encodeStateAsUpdate(ydoc2));

  // now sync a third doc with same name as doc1 and then create PermanentUserData
  const ydoc3 = new Doc();
  applyUpdate(ydoc3, encodeStateAsUpdate(ydoc1));
  const pd3 = new PermanentUserData(ydoc3);
  pd3.setUserMapping(ydoc3, ydoc3.clientID, 'user a');
};

/**
 * Reported here: https://github.com/yjs/yjs/issues/308
 * @param {t.TestCase} tc
 */
const testDiffStateVectorOfUpdateIsEmpty = tc => {
  const ydoc = new Doc();
  /**
   * @type {any}
   */
  let sv = null;
  ydoc.getText().insert(0, 'a');
  ydoc.on('update', update => {
    sv = encodeStateVectorFromUpdate(update);
  });
  // should produce an update with an empty state vector (because previous ops are missing)
  ydoc.getText().insert(0, 'a');
  t__namespace.assert(sv !== null && sv.byteLength === 1 && sv[0] === 0);
};

/**
 * Reported here: https://github.com/yjs/yjs/issues/308
 * @param {t.TestCase} tc
 */
const testDiffStateVectorOfUpdateIgnoresSkips = tc => {
  const ydoc = new Doc();
  /**
   * @type {Array<Uint8Array>}
   */
  const updates = [];
  ydoc.on('update', update => {
    updates.push(update);
  });
  ydoc.getText().insert(0, 'a');
  ydoc.getText().insert(0, 'b');
  ydoc.getText().insert(0, 'c');
  const update13 = mergeUpdates([updates[0], updates[2]]);
  const sv = encodeStateVectorFromUpdate(update13);
  const state = decodeStateVector(sv);
  t__namespace.assert(state.get(ydoc.clientID) === 1);
  t__namespace.assert(state.size === 1);
};

var encoding = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testDiffStateVectorOfUpdateIgnoresSkips: testDiffStateVectorOfUpdateIgnoresSkips,
  testDiffStateVectorOfUpdateIsEmpty: testDiffStateVectorOfUpdateIsEmpty,
  testPermanentUserData: testPermanentUserData,
  testStructReferences: testStructReferences
});

const testInconsistentFormat = () => {
  /**
   * @param {Y.Doc} ydoc
   */
  const testYjsMerge = ydoc => {
    const content = /** @type {Y.XmlText} */ (ydoc.get('text', YXmlText));
    content.format(0, 6, { bold: null });
    content.format(6, 4, { type: 'text' });
    t__namespace.compare(content.toDelta(), [
      {
        attributes: { type: 'text' },
        insert: 'Merge Test'
      },
      {
        attributes: { type: 'text', italic: true },
        insert: ' After'
      }
    ]);
  };
  const initializeYDoc = () => {
    const yDoc = new Doc({ gc: false });

    const content = /** @type {Y.XmlText} */ (yDoc.get('text', YXmlText));
    content.insert(0, ' After', { type: 'text', italic: true });
    content.insert(0, 'Test', { type: 'text' });
    content.insert(0, 'Merge ', { type: 'text', bold: true });
    return yDoc
  };
  {
    const yDoc = initializeYDoc();
    testYjsMerge(yDoc);
  }
  {
    const initialYDoc = initializeYDoc();
    const yDoc = new Doc({ gc: false });
    applyUpdate(yDoc, encodeStateAsUpdate(initialYDoc));
    testYjsMerge(yDoc);
  }
};

/**
 * @param {t.TestCase} tc
 */
const testInfiniteCaptureTimeout = tc => {
  const { array0 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(array0, { captureTimeout: Number.MAX_VALUE });
  array0.push([1, 2, 3]);
  undoManager.stopCapturing();
  array0.push([4, 5, 6]);
  undoManager.undo();
  t__namespace.compare(array0.toArray(), [1, 2, 3]);
};

/**
 * @param {t.TestCase} tc
 */
const testUndoText = tc => {
  const { testConnector, text0, text1 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(text0);

  // items that are added & deleted in the same transaction won't be undo
  text0.insert(0, 'test');
  text0.delete(0, 4);
  undoManager.undo();
  t__namespace.assert(text0.toString() === '');

  // follow redone items
  text0.insert(0, 'a');
  undoManager.stopCapturing();
  text0.delete(0, 1);
  undoManager.stopCapturing();
  undoManager.undo();
  t__namespace.assert(text0.toString() === 'a');
  undoManager.undo();
  t__namespace.assert(text0.toString() === '');

  text0.insert(0, 'abc');
  text1.insert(0, 'xyz');
  testConnector.syncAll();
  undoManager.undo();
  t__namespace.assert(text0.toString() === 'xyz');
  undoManager.redo();
  t__namespace.assert(text0.toString() === 'abcxyz');
  testConnector.syncAll();
  text1.delete(0, 1);
  testConnector.syncAll();
  undoManager.undo();
  t__namespace.assert(text0.toString() === 'xyz');
  undoManager.redo();
  t__namespace.assert(text0.toString() === 'bcxyz');
  // test marks
  text0.format(1, 3, { bold: true });
  t__namespace.compare(text0.toDelta(), [{ insert: 'b' }, { insert: 'cxy', attributes: { bold: true } }, { insert: 'z' }]);
  undoManager.undo();
  t__namespace.compare(text0.toDelta(), [{ insert: 'bcxyz' }]);
  undoManager.redo();
  t__namespace.compare(text0.toDelta(), [{ insert: 'b' }, { insert: 'cxy', attributes: { bold: true } }, { insert: 'z' }]);
};

/**
 * Test case to fix #241
 * @param {t.TestCase} _tc
 */
const testEmptyTypeScope = _tc => {
  const ydoc = new Doc();
  const um = new UndoManager([], { doc: ydoc });
  const yarray = ydoc.getArray();
  um.addToScope(yarray);
  yarray.insert(0, [1]);
  um.undo();
  t__namespace.assert(yarray.length === 0);
};

/**
 * Test case to fix #241
 * @param {t.TestCase} _tc
 */
const testDoubleUndo = _tc => {
  const doc = new Doc();
  const text = doc.getText();
  text.insert(0, '1221');

  const manager = new UndoManager(text);

  text.insert(2, '3');
  text.insert(3, '3');

  manager.undo();
  manager.undo();

  text.insert(2, '3');

  t__namespace.compareStrings(text.toString(), '12321');
};

/**
 * @param {t.TestCase} tc
 */
const testUndoMap = tc => {
  const { testConnector, map0, map1 } = init$1(tc, { users: 2 });
  map0.set('a', 0);
  const undoManager = new UndoManager(map0);
  map0.set('a', 1);
  undoManager.undo();
  t__namespace.assert(map0.get('a') === 0);
  undoManager.redo();
  t__namespace.assert(map0.get('a') === 1);
  // testing sub-types and if it can restore a whole type
  const subType = new YMap();
  map0.set('a', subType);
  subType.set('x', 42);
  t__namespace.compare(map0.toJSON(), /** @type {any} */ ({ a: { x: 42 } }));
  undoManager.undo();
  t__namespace.assert(map0.get('a') === 1);
  undoManager.redo();
  t__namespace.compare(map0.toJSON(), /** @type {any} */ ({ a: { x: 42 } }));
  testConnector.syncAll();
  // if content is overwritten by another user, undo operations should be skipped
  map1.set('a', 44);
  testConnector.syncAll();
  undoManager.undo();
  t__namespace.assert(map0.get('a') === 44);
  undoManager.redo();
  t__namespace.assert(map0.get('a') === 44);

  // test setting value multiple times
  map0.set('b', 'initial');
  undoManager.stopCapturing();
  map0.set('b', 'val1');
  map0.set('b', 'val2');
  undoManager.stopCapturing();
  undoManager.undo();
  t__namespace.assert(map0.get('b') === 'initial');
};

/**
 * @param {t.TestCase} tc
 */
const testUndoArray = tc => {
  const { testConnector, array0, array1 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(array0);
  array0.insert(0, [1, 2, 3]);
  array1.insert(0, [4, 5, 6]);
  testConnector.syncAll();
  t__namespace.compare(array0.toArray(), [1, 2, 3, 4, 5, 6]);
  undoManager.undo();
  t__namespace.compare(array0.toArray(), [4, 5, 6]);
  undoManager.redo();
  t__namespace.compare(array0.toArray(), [1, 2, 3, 4, 5, 6]);
  testConnector.syncAll();
  array1.delete(0, 1); // user1 deletes [1]
  testConnector.syncAll();
  undoManager.undo();
  t__namespace.compare(array0.toArray(), [4, 5, 6]);
  undoManager.redo();
  t__namespace.compare(array0.toArray(), [2, 3, 4, 5, 6]);
  array0.delete(0, 5);
  // test nested structure
  const ymap = new YMap();
  array0.insert(0, [ymap]);
  t__namespace.compare(array0.toJSON(), [{}]);
  undoManager.stopCapturing();
  ymap.set('a', 1);
  t__namespace.compare(array0.toJSON(), [{ a: 1 }]);
  undoManager.undo();
  t__namespace.compare(array0.toJSON(), [{}]);
  undoManager.undo();
  t__namespace.compare(array0.toJSON(), [2, 3, 4, 5, 6]);
  undoManager.redo();
  t__namespace.compare(array0.toJSON(), [{}]);
  undoManager.redo();
  t__namespace.compare(array0.toJSON(), [{ a: 1 }]);
  testConnector.syncAll();
  array1.get(0).set('b', 2);
  testConnector.syncAll();
  t__namespace.compare(array0.toJSON(), [{ a: 1, b: 2 }]);
  undoManager.undo();
  t__namespace.compare(array0.toJSON(), [{ b: 2 }]);
  undoManager.undo();
  t__namespace.compare(array0.toJSON(), [2, 3, 4, 5, 6]);
  undoManager.redo();
  t__namespace.compare(array0.toJSON(), [{ b: 2 }]);
  undoManager.redo();
  t__namespace.compare(array0.toJSON(), [{ a: 1, b: 2 }]);
};

/**
 * @param {t.TestCase} tc
 */
const testUndoXml = tc => {
  const { xml0 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(xml0);
  const child = new YXmlElement('p');
  xml0.insert(0, [child]);
  const textchild = new YXmlText('content');
  child.insert(0, [textchild]);
  t__namespace.assert(xml0.toString() === '<undefined><p>content</p></undefined>');
  // format textchild and revert that change
  undoManager.stopCapturing();
  textchild.format(3, 4, { bold: {} });
  t__namespace.assert(xml0.toString() === '<undefined><p>con<bold>tent</bold></p></undefined>');
  undoManager.undo();
  t__namespace.assert(xml0.toString() === '<undefined><p>content</p></undefined>');
  undoManager.redo();
  t__namespace.assert(xml0.toString() === '<undefined><p>con<bold>tent</bold></p></undefined>');
  xml0.delete(0, 1);
  t__namespace.assert(xml0.toString() === '<undefined></undefined>');
  undoManager.undo();
  t__namespace.assert(xml0.toString() === '<undefined><p>con<bold>tent</bold></p></undefined>');
};

/**
 * @param {t.TestCase} tc
 */
const testUndoEvents = tc => {
  const { text0 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(text0);
  let counter = 0;
  let receivedMetadata = -1;
  undoManager.on('stack-item-added', /** @param {any} event */ event => {
    t__namespace.assert(event.type != null);
    t__namespace.assert(event.changedParentTypes != null && event.changedParentTypes.has(text0));
    event.stackItem.meta.set('test', counter++);
  });
  undoManager.on('stack-item-popped', /** @param {any} event */ event => {
    t__namespace.assert(event.type != null);
    t__namespace.assert(event.changedParentTypes != null && event.changedParentTypes.has(text0));
    receivedMetadata = event.stackItem.meta.get('test');
  });
  text0.insert(0, 'abc');
  undoManager.undo();
  t__namespace.assert(receivedMetadata === 0);
  undoManager.redo();
  t__namespace.assert(receivedMetadata === 1);
};

/**
 * @param {t.TestCase} tc
 */
const testTrackClass = tc => {
  const { users, text0 } = init$1(tc, { users: 3 });
  // only track origins that are numbers
  const undoManager = new UndoManager(text0, { trackedOrigins: new Set([Number]) });
  users[0].transact(() => {
    text0.insert(0, 'abc');
  }, 42);
  t__namespace.assert(text0.toString() === 'abc');
  undoManager.undo();
  t__namespace.assert(text0.toString() === '');
};

/**
 * @param {t.TestCase} tc
 */
const testTypeScope = tc => {
  const { array0 } = init$1(tc, { users: 3 });
  // only track origins that are numbers
  const text0 = new YText();
  const text1 = new YText();
  array0.insert(0, [text0, text1]);
  const undoManager = new UndoManager(text0);
  const undoManagerBoth = new UndoManager([text0, text1]);
  text1.insert(0, 'abc');
  t__namespace.assert(undoManager.undoStack.length === 0);
  t__namespace.assert(undoManagerBoth.undoStack.length === 1);
  t__namespace.assert(text1.toString() === 'abc');
  undoManager.undo();
  t__namespace.assert(text1.toString() === 'abc');
  undoManagerBoth.undo();
  t__namespace.assert(text1.toString() === '');
};

/**
 * @param {t.TestCase} tc
 */
const testUndoInEmbed = tc => {
  const { text0 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(text0);
  const nestedText = new YText('initial text');
  undoManager.stopCapturing();
  text0.insertEmbed(0, nestedText, { bold: true });
  t__namespace.assert(nestedText.toString() === 'initial text');
  undoManager.stopCapturing();
  nestedText.delete(0, nestedText.length);
  nestedText.insert(0, 'other text');
  t__namespace.assert(nestedText.toString() === 'other text');
  undoManager.undo();
  t__namespace.assert(nestedText.toString() === 'initial text');
  undoManager.undo();
  t__namespace.assert(text0.length === 0);
};

/**
 * @param {t.TestCase} tc
 */
const testUndoDeleteFilter = tc => {
  /**
   * @type {Y.Array<any>}
   */
  const array0 = /** @type {any} */ (init$1(tc, { users: 3 }).array0);
  const undoManager = new UndoManager(array0, { deleteFilter: item => !(item instanceof Item) || (item.content instanceof ContentType && item.content.type._map.size === 0) });
  const map0 = new YMap();
  map0.set('hi', 1);
  const map1 = new YMap();
  array0.insert(0, [map0, map1]);
  undoManager.undo();
  t__namespace.assert(array0.length === 1);
  array0.get(0);
  t__namespace.assert(Array.from(array0.get(0).keys()).length === 1);
};

/**
 * This issue has been reported in https://discuss.yjs.dev/t/undomanager-with-external-updates/454/6
 * @param {t.TestCase} _tc
 */
const testUndoUntilChangePerformed = _tc => {
  const doc = new Doc();
  const doc2 = new Doc();
  doc.on('update', update => applyUpdate(doc2, update));
  doc2.on('update', update => applyUpdate(doc, update));

  const yArray = doc.getArray('array');
  const yArray2 = doc2.getArray('array');
  const yMap = new YMap();
  yMap.set('hello', 'world');
  yArray.push([yMap]);
  const yMap2 = new YMap();
  yMap2.set('key', 'value');
  yArray.push([yMap2]);

  const undoManager = new UndoManager([yArray], { trackedOrigins: new Set([doc.clientID]) });
  const undoManager2 = new UndoManager([doc2.get('array')], { trackedOrigins: new Set([doc2.clientID]) });

  transact(doc, () => yMap2.set('key', 'value modified'), doc.clientID);
  undoManager.stopCapturing();
  transact(doc, () => yMap.set('hello', 'world modified'), doc.clientID);
  transact(doc2, () => yArray2.delete(0), doc2.clientID);
  undoManager2.undo();
  undoManager.undo();
  t__namespace.compareStrings(yMap2.get('key'), 'value');
};

/**
 * This issue has been reported in https://github.com/yjs/yjs/issues/317
 * @param {t.TestCase} _tc
 */
const testUndoNestedUndoIssue = _tc => {
  const doc = new Doc({ gc: false });
  const design = doc.getMap();
  const undoManager = new UndoManager(design, { captureTimeout: 0 });

  /**
   * @type {Y.Map<any>}
   */
  const text = new YMap();

  const blocks1 = new YArray();
  const blocks1block = new YMap();

  doc.transact(() => {
    blocks1block.set('text', 'Type Something');
    blocks1.push([blocks1block]);
    text.set('blocks', blocks1block);
    design.set('text', text);
  });

  const blocks2 = new YArray();
  const blocks2block = new YMap();
  doc.transact(() => {
    blocks2block.set('text', 'Something');
    blocks2.push([blocks2block]);
    text.set('blocks', blocks2block);
  });

  const blocks3 = new YArray();
  const blocks3block = new YMap();
  doc.transact(() => {
    blocks3block.set('text', 'Something Else');
    blocks3.push([blocks3block]);
    text.set('blocks', blocks3block);
  });

  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Something Else' } } });
  undoManager.undo();
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Something' } } });
  undoManager.undo();
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Type Something' } } });
  undoManager.undo();
  t__namespace.compare(design.toJSON(), { });
  undoManager.redo();
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Type Something' } } });
  undoManager.redo();
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Something' } } });
  undoManager.redo();
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: 'Something Else' } } });
};

/**
 * This issue has been reported in https://github.com/yjs/yjs/issues/355
 *
 * @param {t.TestCase} _tc
 */
const testConsecutiveRedoBug = _tc => {
  const doc = new Doc();
  const yRoot = doc.getMap();
  const undoMgr = new UndoManager(yRoot);

  let yPoint = new YMap();
  yPoint.set('x', 0);
  yPoint.set('y', 0);
  yRoot.set('a', yPoint);
  undoMgr.stopCapturing();

  yPoint.set('x', 100);
  yPoint.set('y', 100);
  undoMgr.stopCapturing();

  yPoint.set('x', 200);
  yPoint.set('y', 200);
  undoMgr.stopCapturing();

  yPoint.set('x', 300);
  yPoint.set('y', 300);
  undoMgr.stopCapturing();

  t__namespace.compare(yPoint.toJSON(), { x: 300, y: 300 });

  undoMgr.undo(); // x=200, y=200
  t__namespace.compare(yPoint.toJSON(), { x: 200, y: 200 });
  undoMgr.undo(); // x=100, y=100
  t__namespace.compare(yPoint.toJSON(), { x: 100, y: 100 });
  undoMgr.undo(); // x=0, y=0
  t__namespace.compare(yPoint.toJSON(), { x: 0, y: 0 });
  undoMgr.undo(); // nil
  t__namespace.compare(yRoot.get('a'), undefined);

  undoMgr.redo(); // x=0, y=0
  yPoint = yRoot.get('a');

  t__namespace.compare(yPoint.toJSON(), { x: 0, y: 0 });
  undoMgr.redo(); // x=100, y=100
  t__namespace.compare(yPoint.toJSON(), { x: 100, y: 100 });
  undoMgr.redo(); // x=200, y=200
  t__namespace.compare(yPoint.toJSON(), { x: 200, y: 200 });
  undoMgr.redo(); // expected x=300, y=300, actually nil
  t__namespace.compare(yPoint.toJSON(), { x: 300, y: 300 });
};

/**
 * This issue has been reported in https://github.com/yjs/yjs/issues/304
 *
 * @param {t.TestCase} _tc
 */
const testUndoXmlBug = _tc => {
  const origin = 'origin';
  const doc = new Doc();
  const fragment = doc.getXmlFragment('t');
  const undoManager = new UndoManager(fragment, {
    captureTimeout: 0,
    trackedOrigins: new Set([origin])
  });

  // create element
  doc.transact(() => {
    const e = new YXmlElement('test-node');
    e.setAttribute('a', '100');
    e.setAttribute('b', '0');
    fragment.insert(fragment.length, [e]);
  }, origin);

  // change one attribute
  doc.transact(() => {
    const e = fragment.get(0);
    e.setAttribute('a', '200');
  }, origin);

  // change both attributes
  doc.transact(() => {
    const e = fragment.get(0);
    e.setAttribute('a', '180');
    e.setAttribute('b', '50');
  }, origin);

  undoManager.undo();
  undoManager.undo();
  undoManager.undo();

  undoManager.redo();
  undoManager.redo();
  undoManager.redo();
  t__namespace.compare(fragment.toString(), '<test-node a="180" b="50"></test-node>');
};

/**
 * This issue has been reported in https://github.com/yjs/yjs/issues/343
 *
 * @param {t.TestCase} _tc
 */
const testUndoBlockBug = _tc => {
  const doc = new Doc({ gc: false });
  const design = doc.getMap();

  const undoManager = new UndoManager(design, { captureTimeout: 0 });

  const text = new YMap();

  const blocks1 = new YArray();
  const blocks1block = new YMap();
  doc.transact(() => {
    blocks1block.set('text', '1');
    blocks1.push([blocks1block]);

    text.set('blocks', blocks1block);
    design.set('text', text);
  });

  const blocks2 = new YArray();
  const blocks2block = new YMap();
  doc.transact(() => {
    blocks2block.set('text', '2');
    blocks2.push([blocks2block]);
    text.set('blocks', blocks2block);
  });

  const blocks3 = new YArray();
  const blocks3block = new YMap();
  doc.transact(() => {
    blocks3block.set('text', '3');
    blocks3.push([blocks3block]);
    text.set('blocks', blocks3block);
  });

  const blocks4 = new YArray();
  const blocks4block = new YMap();
  doc.transact(() => {
    blocks4block.set('text', '4');
    blocks4.push([blocks4block]);
    text.set('blocks', blocks4block);
  });

  // {"text":{"blocks":{"text":"4"}}}
  undoManager.undo(); // {"text":{"blocks":{"3"}}}
  undoManager.undo(); // {"text":{"blocks":{"text":"2"}}}
  undoManager.undo(); // {"text":{"blocks":{"text":"1"}}}
  undoManager.undo(); // {}
  undoManager.redo(); // {"text":{"blocks":{"text":"1"}}}
  undoManager.redo(); // {"text":{"blocks":{"text":"2"}}}
  undoManager.redo(); // {"text":{"blocks":{"text":"3"}}}
  undoManager.redo(); // {"text":{}}
  t__namespace.compare(design.toJSON(), { text: { blocks: { text: '4' } } });
};

/**
 * Undo text formatting delete should not corrupt peer state.
 *
 * @see https://github.com/yjs/yjs/issues/392
 * @param {t.TestCase} _tc
 */
const testUndoDeleteTextFormat = _tc => {
  const doc = new Doc();
  const text = doc.getText();
  text.insert(0, 'Attack ships on fire off the shoulder of Orion.');
  const doc2 = new Doc();
  const text2 = doc2.getText();
  applyUpdate(doc2, encodeStateAsUpdate(doc));
  const undoManager = new UndoManager(text);

  text.format(13, 7, { bold: true });
  undoManager.stopCapturing();
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  text.format(16, 4, { bold: null });
  undoManager.stopCapturing();
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  undoManager.undo();
  applyUpdate(doc2, encodeStateAsUpdate(doc));

  const expect = [
    { insert: 'Attack ships ' },
    {
      insert: 'on fire',
      attributes: { bold: true }
    },
    { insert: ' off the shoulder of Orion.' }
  ];
  t__namespace.compare(text.toDelta(), expect);
  t__namespace.compare(text2.toDelta(), expect);
};

/**
 * Undo text formatting delete should not corrupt peer state.
 *
 * @see https://github.com/yjs/yjs/issues/392
 * @param {t.TestCase} _tc
 */
const testBehaviorOfIgnoreremotemapchangesProperty = _tc => {
  const doc = new Doc();
  const doc2 = new Doc();
  doc.on('update', update => applyUpdate(doc2, update, doc));
  doc2.on('update', update => applyUpdate(doc, update, doc2));
  const map1 = doc.getMap();
  const map2 = doc2.getMap();
  const um1 = new UndoManager(map1, { ignoreRemoteMapChanges: true });
  map1.set('x', 1);
  map2.set('x', 2);
  map1.set('x', 3);
  map2.set('x', 4);
  um1.undo();
  t__namespace.assert(map1.get('x') === 2);
  t__namespace.assert(map2.get('x') === 2);
};

/**
 * Special deletion case.
 *
 * @see https://github.com/yjs/yjs/issues/447
 * @param {t.TestCase} _tc
 */
const testSpecialDeletionCase = _tc => {
  const origin = 'undoable';
  const doc = new Doc();
  const fragment = doc.getXmlFragment();
  const undoManager = new UndoManager(fragment, { trackedOrigins: new Set([origin]) });
  doc.transact(() => {
    const e = new YXmlElement('test');
    e.setAttribute('a', '1');
    e.setAttribute('b', '2');
    fragment.insert(0, [e]);
  });
  t__namespace.compareStrings(fragment.toString(), '<test a="1" b="2"></test>');
  doc.transact(() => {
    // change attribute "b" and delete test-node
    const e = fragment.get(0);
    e.setAttribute('b', '3');
    fragment.delete(0);
  }, origin);
  t__namespace.compareStrings(fragment.toString(), '');
  undoManager.undo();
  t__namespace.compareStrings(fragment.toString(), '<test a="1" b="2"></test>');
};

/**
 * Deleted entries in a map should be restored on undo.
 *
 * @see https://github.com/yjs/yjs/issues/500
 * @param {t.TestCase} tc
 */
const testUndoDeleteInMap = (tc) => {
  const { map0 } = init$1(tc, { users: 3 });
  const undoManager = new UndoManager(map0, { captureTimeout: 0 });
  map0.set('a', 'a');
  map0.delete('a');
  map0.set('a', 'b');
  map0.delete('a');
  map0.set('a', 'c');
  map0.delete('a');
  map0.set('a', 'd');
  t__namespace.compare(map0.toJSON(), { a: 'd' });
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), {});
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), { a: 'c' });
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), {});
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), { a: 'b' });
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), {});
  undoManager.undo();
  t__namespace.compare(map0.toJSON(), { a: 'a' });
};

/**
 * It should expose the StackItem being processed if undoing
 *
 * @param {t.TestCase} _tc
 */
const testUndoDoingStackItem = async (_tc) => {
  const doc = new Doc();
  const text = doc.getText('text');
  const undoManager = new UndoManager([text]);
  undoManager.on('stack-item-added', /** @param {any} event */ event => {
    event.stackItem.meta.set('str', '42');
  });
  let metaUndo = /** @type {any} */ (null);
  let metaRedo = /** @type {any} */ (null);
  text.observe((event) => {
    const /** @type {Y.UndoManager} */ origin = event.transaction.origin;
    if (origin === undoManager && origin.undoing) {
      metaUndo = origin.currStackItem?.meta.get('str');
    } else if (origin === undoManager && origin.redoing) {
      metaRedo = origin.currStackItem?.meta.get('str');
    }
  });
  text.insert(0, 'abc');
  undoManager.undo();
  undoManager.redo();
  t__namespace.compare(metaUndo, '42', 'currStackItem is accessible while undoing');
  t__namespace.compare(metaRedo, '42', 'currStackItem is accessible while redoing');
  t__namespace.compare(undoManager.currStackItem, null, 'currStackItem is null after observe/transaction');
};

var undoredo = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testBehaviorOfIgnoreremotemapchangesProperty: testBehaviorOfIgnoreremotemapchangesProperty,
  testConsecutiveRedoBug: testConsecutiveRedoBug,
  testDoubleUndo: testDoubleUndo,
  testEmptyTypeScope: testEmptyTypeScope,
  testInconsistentFormat: testInconsistentFormat,
  testInfiniteCaptureTimeout: testInfiniteCaptureTimeout,
  testSpecialDeletionCase: testSpecialDeletionCase,
  testTrackClass: testTrackClass,
  testTypeScope: testTypeScope,
  testUndoArray: testUndoArray,
  testUndoBlockBug: testUndoBlockBug,
  testUndoDeleteFilter: testUndoDeleteFilter,
  testUndoDeleteInMap: testUndoDeleteInMap,
  testUndoDeleteTextFormat: testUndoDeleteTextFormat,
  testUndoDoingStackItem: testUndoDoingStackItem,
  testUndoEvents: testUndoEvents,
  testUndoInEmbed: testUndoInEmbed,
  testUndoMap: testUndoMap,
  testUndoNestedUndoIssue: testUndoNestedUndoIssue,
  testUndoText: testUndoText,
  testUndoUntilChangePerformed: testUndoUntilChangePerformed,
  testUndoXml: testUndoXml,
  testUndoXmlBug: testUndoXmlBug
});

/**
 * Testing if encoding/decoding compatibility and integration compatiblity is given.
 * We expect that the document always looks the same, even if we upgrade the integration algorithm, or add additional encoding approaches.
 *
 * The v1 documents were generated with Yjs v13.2.0 based on the randomisized tests.
 */


/**
 * @param {t.TestCase} tc
 */
const testArrayCompatibilityV1 = tc => {
  const oldDoc = 'BV8EAAcBBWFycmF5AAgABAADfQF9An0DgQQDAYEEAAEABMEDAAQAAccEAAQFASEABAsIc29tZXByb3ACqAQNAX0syAQLBAUBfYoHwQQPBAUBwQQQBAUByAQRBAUBfYoHyAQQBBEBfY0HyAQTBBEBfY0HyAQUBBEBfY0HyAQVBBEBfY0HyAQQBBMBfY4HyAQXBBMBfY4HwQQYBBMBxwQXBBgACAAEGgR9AX0CfQN9BMEBAAEBAQADxwQLBA8BIQAEIwhzb21lcHJvcAKoBCUBfSzHBBkEEwEhAAQnCHNvbWVwcm9wAqgEKQF9LMcCAAMAASEABCsIc29tZXByb3ACqAQtAX0syAEBAQIBfZMHyAQvAQIBfZMHwQEGAQcBAAPBBDEBBwEABMcBGQEVAAgABDoEfQF9An0DfQTHAAgADgAIAAQ/BH0BfQJ9A30ExwQYBBkACAAERAR9AX0CfQN9BMcEIwQPASEABEkIc29tZXByb3ACqARLAX0swQAKAAkBxwEZBDoACAAETgR9AX0CfQN9BMcEEAQXAAgABFMEfQF9An0DfQTHAxsDHAAIAARYBH0BfQJ9A30ExwECAQ0BIQAEXQhzb21lcHJvcAKoBF8BfSzHAQQBBQAIAARhBH0BfQJ9A30ExwABAAYBIQAEZghzb21lcHJvcAKoBGgBfSzHAywDLQEhAARqCHNvbWVwcm9wAqgEbAF9LMcCCgMPASEABG4Ic29tZXByb3ACqARwAX0sxwMfAQABIQAEcghzb21lcHJvcAKoBHQBfSzHABcAGAEhAAR2CHNvbWVwcm9wAqgEeAF9LMcCEwMfAAgABHoEfQF9An0DfQTHARYBFwAIAAR/BH0BfQJ9A30ExwAIBD8BIQAEhAEIc29tZXByb3ACqASGAQF9LMcAGQAPAAgABIgBBH0BfQJ9A30ExwMBAScACAAEjQEEfQF9An0DfQTHAB4CDgEhAASSAQhzb21lcHJvcAKoBJQBAX0syAErAR4EfYQIfYQIfYQIfYQIxwB7AHwBIQAEmgEIc29tZXByb3ACqAScAQF9LMgBRgIrA32ICH2ICH2ICMgAEgAIAn2KCH2KCHADAAEBBWFycmF5AYcDAAEhAAMBCHNvbWVwcm9wAqgDAwF9LIEDAQEABIEDBQEABEECAAHIAw8CAAF9hwfIAxACAAF9hwfBAxECAAHHAAEAAgEhAAMTCHNvbWVwcm9wAqgDFQF9LIEEAAKIAxgBfYwHyAMPAxABfY8HwQMaAxAByAMbAxABfY8HyAMPAxoBfZAHyAMdAxoBfZAHxwACAw8BIQADHwhzb21lcHJvcAKoAyEBfSzHAxoDGwEhAAMjCHNvbWVwcm9wAqgDJQF9LMcCAAMAASEAAycIc29tZXByb3ACqAMpAX0swQMQAxEByAMrAxEBfZIHyAMsAxEBfZIHyAMtAxEBfZIHwQMYAxkBAATIAQYBBwF9lAfIAzQBBwF9lAfHAQcELwAIAAM2BH0BfQJ9A30EyAEBAR4CfZUHfZUHyAMsAy0DfZcHfZcHfZcHxwQTBBQBIQADQAhzb21lcHJvcAKoA0IBfSxIAAACfZgHfZgHyANFAAABfZgHxwEEAQUACAADRwR9AX0CfQN9BMgDQAQUAX2ZB8EDTAQUAscABgIXASEAA08Ic29tZXByb3ACqANRAX0syAM/Ay0BfZwHyAMfAQABfZ0HxwM2BC8ACAADVQR9AX0CfQN9BMcDRQNGASEAA1oIc29tZXByb3ACqANcAX0sxwMPAx0BIQADXghzb21lcHJvcAKoA2ABfSzIAQgBBgF9pAfIAQQDRwN9pwd9pwd9pwfIAA8AEAJ9rAd9rAfHAAAAAwAIAANoBH0BfQJ9A30EyAMQAysDfbIHfbIHfbIHxwQxAQcACAADcAR9AX0CfQN9BMcBAAQfASEAA3UIc29tZXByb3ACqAN3AX0syAM/A1MBfbUHyAN5A1MCfbUHfbUHyAMtAy4DfbcHfbcHfbcHyAACAhMCfbkHfbkHyAOAAQITAX25B8cBKwM7AAgAA4IBBH0BfQJ9A30ExwEZARUBIQADhwEIc29tZXByb3ACqAOJAQF9LMcCHAQLAAgAA4sBBH0BfQJ9A30EyAQZBCcBfbsHyAOQAQQnAn27B327B8cDkAEDkQEBIQADkwEIc29tZXByb3ACqAOVAQF9LMcDaAADAAgAA5cBBH0BfQJ9A30ExwN5A3oACAADnAEEfQF9An0DfQTHA4sBBAsACAADoQEEfQF9An0DfQTHA5MBA5EBASEAA6YBCHNvbWVwcm9wAqgDqAEBfSzHAAADaAAIAAOqAQR9AX0CfQN9BMgADgAZA328B328B328B8gECwQjBH2CCH2CCH2CCH2CCMcDLQN8ASEAA7YBCHNvbWVwcm9wAqgDuAEBfSzHBAoEAAAIAAO6AQR9AX0CfQN9BMgDgAEDgQECfYUIfYUIWgIAAQEFYXJyYXkBAARHAgAACAACBQR9AX0CfQN9BMECBQIAAQADwQIFAgoBAATBAAICBQEAA8cABgAHAAgAAhcEfQF9An0DfQTHAxkECwEhAAIcCHNvbWVwcm9wAqgCHgF9LMcABAAFASEAAiAIc29tZXByb3ACqAIiAX0syAAIAA4BfZYHyAMRAxIBfZoHxwMdAx4ACAACJgR9AX0CfQN9BMcEFgQRAAgAAisEfQF9An0DfQTHBAoEAAAIAAIwBH0BfQJ9A30EyAAOABkDfaAHfaAHfaAHxwEFACIACAACOAR9AX0CfQN9BMcDJwQrAAgAAj0EfQF9An0DfQTHAhcABwAIAAJCBH0BfQJ9A30EyAEABB8CfaUHfaUHxwQrAwABIQACSQhzb21lcHJvcAKoAksBfSzHBCcEEwAIAAJNBH0BfQJ9A30ExwMbAxwACAACUgR9AX0CfQN9BMcEJwJNASEAAlcIc29tZXByb3ACqAJZAX0sxwQvBDAACAACWwR9AX0CfQN9BMcCPQQrASEAAmAIc29tZXByb3ACqAJiAX0sxwAYAycBIQACZAhzb21lcHJvcAKoAmYBfSzIAQEBHgJ9swd9swfIAmQDJwN9tAd9tAd9tAfHAkkDAAAIAAJtBH0BfQJ9A30ExwJkAmoACAACcgR9AX0CfQN9BMcCJgMeAAgAAncEfQF9An0DfQTHAiUDEgEhAAJ8CHNvbWVwcm9wAqgCfgF9LMgBFwEYBH24B324B324B324B8cBAQJoASEAAoQBCHNvbWVwcm9wAqgChgEBfSzHAkkCbQAIAAKIAQR9AX0CfQN9BMcCSAQfASEAAo0BCHNvbWVwcm9wAqgCjwEBfSzIAQYEMQR9vgd9vgd9vgd9vgfHAAAAAwEhAAKVAQhzb21lcHJvcAKoApcBAX0sxwJNBBMBIQACmQEIc29tZXByb3ACqAKbAQF9LMcCJgJ3ASEAAp0BCHNvbWVwcm9wAqgCnwEBfSzHAAEABgAIAAKhAQR9AX0CfQN9BMgCjQEEHwF9gwjIAyMDGwF9hgjHBF0BDQAIAAKoAQR9AX0CfQN9BMcDPAEeAAgAAq0BBH0BfQJ9A30EagEAAQEFYXJyYXkByAEAAwABfYMHyAEBAwABfYMHwQECAwAByAEBAQIBfYYHyAEEAQIBfYYHyAEFAQIBfYYHwQEGAQIBxwEFAQYACAABCAR9AX0CfQN9BMEBAgEDAQAEwQEFAQgByAESAQgBfYsHyAETAQgBfYsHyAEUAQgBfYsHgQQAAYEBFgGIARcBfZEHxwEUARUACAABGQR9AX0CfQN9BMcBAQEEAAgAAR4EfQF9An0DfQTHARQBGQEhAAEjCHNvbWVwcm9wAqgBJQF9LMEDAQMFAQADxwEBAR4BIQABKwhzb21lcHJvcAKoAS0BfSzHAgUAHgEhAAEvCHNvbWVwcm9wAqgBMQF9LMcECwQjASEAATMIc29tZXByb3ACqAE1AX0sxwMtAy4ACAABNwR9AX0CfQN9BMcDDwMdAAgAATwEfQF9An0DfQTHAQIBDQAIAAFBBH0BfQJ9A30ExwQWBBEBIQABRghzb21lcHJvcAKoAUgBfSzBABgDJwHIAUoDJwF9nwfHBBcEGgAIAAFMBH0BfQJ9A30ExwEABB8BIQABUQhzb21lcHJvcAKoAVMBfSzIAx0DHgJ9oQd9oQfIARkBFQF9ogfIAhwECwN9qAd9qAd9qAfIAxEDEgF9qgfIBAABFgJ9qwd9qwfIABAAEQF9rQfIAV4AEQF9rQfIAV8AEQJ9rQd9rQfIAV4BXwR9rwd9rwd9rwd9rwfIABABXgN9sAd9sAd9sAfIAWgBXgF9sAfHBA8EEAAIAAFqBH0BfQJ9A30ExwQYBBkBIQABbwhzb21lcHJvcAKoAXEBfSzHAAcAEgEhAAFzCHNvbWVwcm9wAqgBdQF9LEcAAAAIAAF3BH0BfQJ9A30ExwMPATwBIQABfAhzb21lcHJvcAKoAX4BfSzIAXwBPAJ9ugd9ugfBAYEBATwCxwFoAWkACAABhAEEfQF9An0DfQTHAV8BYAAIAAGJAQR9AX0CfQN9BMcADgAZASEAAY4BCHNvbWVwcm9wAqgBkAEBfSzIAx8BAAF9vQfIAZIBAQABfb0HyAQVBBYCfb8Hfb8HxwQaBBgBIQABlgEIc29tZXByb3ACqAGYAQF9LMgBHgEEA32ACH2ACH2ACMcEGAFvAAgAAZ0BBH0BfQJ9A30ExwMTAAIBIQABogEIc29tZXByb3ACqAGkAQF9LMcBkgEBkwEBIQABpgEIc29tZXByb3ACqAGoAQF9LMcBnAEBBAEhAAGqAQhzb21lcHJvcAKoAawBAX0syAF8AYABBH2HCH2HCH2HCH2HCMgBpgEBkwEDfYkIfYkIfYkIYQAAAQEFYXJyYXkBiAAAAX2AB4EAAQHBAAAAAQLIAAQAAQF9gQfIAAEAAgF9hAfIAAYAAgF9hAfIAAcAAgF9hAfBAAgAAgHBAAgACQEAA8gACAAKAX2FB8EADgAKAcgADwAKAX2FB8gAEAAKAX2FB8cABwAIAAgAABIEfQF9An0DfQTIAgADAAF9iQfIABcDAAF9iQfHAA4ADwAIAAAZBH0BfQJ9A30ExwIFAgABIQAAHghzb21lcHJvcAKoACABfSzHAQUBEgEhAAAiCHNvbWVwcm9wAqgAJAF9LMcAHgIOAAgAACYEfQF9An0DfQTHBBQEFQAIAAArBH0BfQJ9A30ExwAAAAMACAAAMAR9AX0CfQN9BMcBBQAiAAgAADUEfQF9An0DfQTIAx4DGgN9mwd9mwd9mwfHAhcABwAIAAA9BH0BfQJ9A30ExwEYAxcBIQAAQghzb21lcHJvcAKoAEQBfSzBACIBEgEABMcDDwMdASEAAEsIc29tZXByb3ACqABNAX0sxwQYBBkBIQAATwhzb21lcHJvcAKoAFEBfSzHACIARgAIAABTBH0BfQJ9A30ExwMdAx4BIQAAWAhzb21lcHJvcAKoAFoBfSzIAB4AJgF9owfHAzYELwAIAABdBH0BfQJ9A30EyAQwAQIDfaYHfaYHfaYHyABkAQIBfakHyAAXABgCfa4Hfa4HxwQjBA8BIQAAaAhzb21lcHJvcAKoAGoBfSzHAycEKwAIAABsBH0BfQJ9A30ExwABAAYACAAAcQR9AX0CfQN9BMcAZABlAAgAAHYEfQF9An0DfQTIAAcAEgF9sQfIAHsAEgN9sQd9sQd9sQfIAA8AEAF9tgfHARMBFAAIAACAAQR9AX0CfQN9BMcDIwMbAAgAAIUBBH0BfQJ9A30ExwEVAQgACAAAigEEfQF9An0DfQTHAIoBAQgBIQAAjwEIc29tZXByb3ACqACRAQF9LMcCFwA9AAgAAJMBBH0BfQJ9A30ExwEYAEIACAAAmAEEfQF9An0DfQTHAzQDNQEhAACdAQhzb21lcHJvcAKoAJ8BAX0sxwAQABEBIQAAoQEIc29tZXByb3ACqACjAQF9LMgAgAEBFAF9gQjHBBYEEQEhAACmAQhzb21lcHJvcAKoAKgBAX0sxwAHAHsACAAAqgEEfQF9An0DfQQFABAAAQIDCQUPAR8CIwJDAkYFTAJQAlkCaQKQAQKeAQKiAQKnAQICDgAFCg0dAiECSgJYAmECZQJ9AoUBAo4BApYBApoBAp4BAgQUBAcMAhACGQEfBCQCKAIsAjEJSgJNAV4CZwJrAm8CcwJ3AoUBApMBApsBAgMWAAECAgULEgEUAhcCGwEgAiQCKAIrAS8FQQJNAlACWwJfAnYCiAEClAECpwECtwECARYAAQMBBwENBhYCJAInBCwCMAI0AkcCSgFSAnACdAJ9AoIBAo8BApcBAqMBAqcBAqsBAg==';
  const oldVal = JSON.parse('[[1,2,3,4],472,472,{"someprop":44},472,[1,2,3,4],{"someprop":44},[1,2,3,4],[1,2,3,4],[1,2,3,4],{"someprop":44},449,448,[1,2,3,4],[1,2,3,4],{"someprop":44},452,{"someprop":44},[1,2,3,4],[1,2,3,4],[1,2,3,4],[1,2,3,4],452,[1,2,3,4],497,{"someprop":44},497,497,497,{"someprop":44},[1,2,3,4],522,522,452,470,{"someprop":44},[1,2,3,4],453,{"someprop":44},480,480,480,508,508,508,[1,2,3,4],[1,2,3,4],502,492,492,453,{"someprop":44},496,496,496,[1,2,3,4],496,493,495,495,495,495,493,[1,2,3,4],493,493,453,{"someprop":44},{"someprop":44},505,505,517,517,505,[1,2,3,4],{"someprop":44},509,{"someprop":44},521,521,521,509,477,{"someprop":44},{"someprop":44},485,485,{"someprop":44},515,{"someprop":44},451,{"someprop":44},[1,2,3,4],516,516,516,516,{"someprop":44},499,499,469,469,[1,2,3,4],[1,2,3,4],512,512,512,{"someprop":44},454,487,487,487,[1,2,3,4],[1,2,3,4],454,[1,2,3,4],[1,2,3,4],{"someprop":44},[1,2,3,4],459,[1,2,3,4],513,459,{"someprop":44},[1,2,3,4],482,{"someprop":44},[1,2,3,4],[1,2,3,4],459,[1,2,3,4],{"someprop":44},[1,2,3,4],484,454,510,510,510,510,468,{"someprop":44},468,[1,2,3,4],[1,2,3,4],[1,2,3,4],[1,2,3,4],467,[1,2,3,4],467,486,486,486,[1,2,3,4],489,451,[1,2,3,4],{"someprop":44},[1,2,3,4],[1,2,3,4],{"someprop":44},{"someprop":44},483,[1,2,3,4],{"someprop":44},{"someprop":44},{"someprop":44},{"someprop":44},519,519,519,519,506,506,[1,2,3,4],{"someprop":44},464,{"someprop":44},481,481,[1,2,3,4],{"someprop":44},[1,2,3,4],464,475,475,475,463,{"someprop":44},[1,2,3,4],518,[1,2,3,4],[1,2,3,4],463,455,498,498,498,466,471,471,471,501,[1,2,3,4],501,501,476,{"someprop":44},466,[1,2,3,4],{"someprop":44},503,503,503,466,455,490,474,{"someprop":44},457,494,494,{"someprop":44},457,479,{"someprop":44},[1,2,3,4],500,500,500,{"someprop":44},[1,2,3,4],[1,2,3,4],{"someprop":44},{"someprop":44},{"someprop":44},[1,2,3,4],[1,2,3,4],{"someprop":44},[1,2,3,4],[1,2,3,4],[1,2,3,4],[1,2,3],491,491,[1,2,3,4],504,504,504,504,465,[1,2,3,4],{"someprop":44},460,{"someprop":44},488,488,488,[1,2,3,4],[1,2,3,4],{"someprop":44},{"someprop":44},514,514,514,514,{"someprop":44},{"someprop":44},{"someprop":44},458,[1,2,3,4],[1,2,3,4],462,[1,2,3,4],[1,2,3,4],{"someprop":44},462,{"someprop":44},[1,2,3,4],{"someprop":44},[1,2,3,4],507,{"someprop":44},{"someprop":44},507,507,{"someprop":44},{"someprop":44},[1,2,3,4],{"someprop":44},461,{"someprop":44},473,461,[1,2,3,4],461,511,511,461,{"someprop":44},{"someprop":44},520,520,520,[1,2,3,4],458]');
  const doc = new Doc();
  applyUpdate(doc, buffer__namespace.fromBase64(oldDoc));
  t__namespace.compare(doc.getArray('array').toJSON(), oldVal);
};

/**
 * @param {t.TestCase} tc
 */
const testMapDecodingCompatibilityV1 = tc => {
  const oldDoc = 'BVcEAKEBAAGhAwEBAAShBAABAAGhBAECoQEKAgAEoQQLAQAEoQMcAaEEFQGhAiECAAShAS4BoQQYAaEEHgGhBB8BoQQdAQABoQQhAaEEIAGhBCMBAAGhBCUCoQQkAqEEKAEABKEEKgGhBCsBoQQwAQABoQQxAaEEMgGhBDQBAAGhBDYBoQQ1AQAEoQQ5AQABoQQ4AQAEoQM6AQAEoQRFAaEESgEAAaEESwEABKEETQGhBEABoQRSAgABoQRTAgAEoQRVAgABoQReAaEEWAEABKEEYAEAAaEEZgKhBGECAAShBGsBAAGhAaUBAgAEoQRwAgABoQRzAQAEoQR5AQABoQSAAQEABKEEggEBAAGhBIcBAwABoQGzAQEAAaEEjQECpwHMAQAIAASRAQR9AX0CfQN9BGcDACEBA21hcAN0d28BoQMAAQAEoQMBAQABoQMGAQAEIQEDbWFwA29uZQOhBAEBAAShAw8CoQMQAaEDFgEAAaEDFwEAAaEDGAGhAxwBAAGhAx0BoQIaBAAEoQMjAgABoQMpAQABoQMfAQABoQMrAQABoQMvAaEDLQEAAaEDMQIABKEDNQGhAzIBoQM6AaEDPAGhBCMBAAGhAU8BAAGhA0ADoQJCAQABoQNEAgABoQNFAgAEoQJEAQABoQNLAaEEQAEABKEESgEAAaEDWAGhA1MBAAGhA1oBAAGhA10DoQNbAQABoQNhAwABoQNiAQAEoQNmAaEDaAWhA20BAAShA3IBAAGhA3MBAAShA3gBoQN6A6EDfwEAAaEDgwEBAAShA4UBAgABoQOLAQGhA4IBAaEDjQEBoQOOAQEAAaEDjwEBAAShA5ABAaEDkgEBoQOXAQEABKEDmQEBAAGhA5gBAQABoQOgAQEAAaEDngEBaQIAIQEDbWFwA3R3bwGhAwABoQEAAQABoQIBAQAEoQIEAaEDAQKhAQwDAAShAg4BAAShAhMBoQQJBAABoQQVAQABoQIeAaECHAGhBBgBAAShAiICAAShBB4BAAShBB8BAAGhAzwBAAGhBCMCoQM9AqEDPgEAAaECOQEABKECPAGhAkEBAAGhAjoBAAGhAkIBAAShAkQBAAShAksBAAGhA0UCAAShAlMCoQJQAQAEoQJZAaECWgEAAaECYAKhAl8BAAShAmMCAAGhAmoBoQJkAgAEoQRSAQABoQJzAQAEoQRTAQAEoQJ6AQAEoQJ1AQABoQKEAQEABKEChgEBoQJ/AgABoQKLAQEABKECjwECAAGhApUBAQABoQKXAQGhAo0BAQABoQKaAQGhApkBAQABoQKcAQEAAaECnwEBAAShAqEBAaECnQEBAAShAqYBAaECpwEBAAGhAqwBAQABoQKtAQEABKECrwECAAF5AQAhAQNtYXADb25lASEBA21hcAN0d28CAAGhAQABoQMAAaEBBAEAAaEBBQGhAQYBoQMPAaEEAQGhAQoBoQELAaEBDAEABKEBDgEAAaEBDQEABKEBFQEABKEDHAKhBBUBAAShASECAAShAScBoQQWAwAEoQIhAgABoQEvAaECIgEABKEBOAEAAaEBNwEAAaEBPwGhAzoBAAShAUIBoQQjAQABoQFIAQABoQFKAaEDPgEAAaECOgEAAaEBTwIAAaEBUgEAAaECQQGhAVQCoQFWAgABoQFYAQAEoQFcAqEBWgEAAaEBYgShAWMBAAGhAWgBAAGhAWkCAAGhAW4BAAGhAWsBAAShAXABAAShAXcCAAShAX0BAAShAYIBAaEBcgEAAaEBhwEBoQGIAQEABKEBigEBAAShAZABAQAEoQGLAQIABKEBlQEBAAShBGkEAAGhAagBAQAEoQRzAQABoQGvAQKhBHsBAAGhAbMBAgAEoQSAAQEAAaEBuwECAAGhAbYBAqEEiwEBAAShAcIBAQAEoQHHAQEABKEEkAEBpwHRAQEoAAHSAQdkZWVwa2V5AXcJZGVlcHZhbHVloQHMAQFiAAAhAQNtYXADb25lAwABoQACASEBA21hcAN0d28CAAShAAQBoQAGAaEACwEAAaEADQIABKEADAEABKEAEAEABKEAGgEABKEAHwEABKEAFQGhACQBAAGhACoBoQApAaEALAGhAC0BoQAuAaEALwEAAaEAMAIAAaEANAEABKEAMQEABKEANgEAAaEAQAIAAaEAOwGhAEMCAAShAEcBAAShAEwBoQBFAQAEoQBRAQAEoQBXAqEAUgEABKEAXgIAAaEAZAKhAF0BoQBnAqEAaAEABKEAawGhAGoCoQBwAQABoQBzAQAEoQB1AQABoQB6AaEAcgGhAHwBAAShAH4BoQB9AgABoQCFAQEABKEAhwEBAAShAIwBAaEAgwEBAAShAJIBAQAEoQCXAQIABKEAkQEBAAGhAJ0BAQAEoQCiAQEABKEApAECAAGhAK8BAqEAqQEBAAGhALMBAQABBQABALcBAQIA0gHUAQEEAQCRAQMBAKUBAgEAuQE=';
  // eslint-disable-next-line
  const oldVal = /** @type {any} */ ({"one":[1,2,3,4],"two":{"deepkey":"deepvalue"}});
  const doc = new Doc();
  applyUpdate(doc, buffer__namespace.fromBase64(oldDoc));
  t__namespace.compare(doc.getMap('map').toJSON(), oldVal);
};

/**
 * @param {t.TestCase} tc
 */
const testTextDecodingCompatibilityV1 = tc => {
  const oldDoc = 'BS8EAAUBBHRleHRveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9RAQAATHBBAEEAAHBBAIEAAHEBAMEAAQxdXUKxQQCBANveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9xQMJBAFveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9xQMJBAlveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9xgMBAwIGaXRhbGljBHRydWXGBAsDAgVjb2xvcgYiIzg4OCLEBAwDAgExxAQNAwIBMsEEDgMCAsYEEAMCBml0YWxpYwRudWxsxgQRAwIFY29sb3IEbnVsbMQDAQQLATHEBBMECwIyOcQEFQQLCzl6anpueXdvaHB4xAQgBAsIY25icmNhcQrBAxADEQHGAR8BIARib2xkBHRydWXGAgACAQRib2xkBG51bGzFAwkECm97ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn3GARABEQZpdGFsaWMEdHJ1ZcYELQERBWNvbG9yBiIjODg4IsYBEgETBml0YWxpYwRudWxsxgQvARMFY29sb3IEbnVsbMYCKwIsBGJvbGQEdHJ1ZcYCLQIuBGJvbGQEbnVsbMYCjAECjQEGaXRhbGljBHRydWXGAo4BAo8BBml0YWxpYwRudWxswQA2ADcBxgQ1ADcFY29sb3IGIiM4ODgixgNlA2YFY29sb3IEbnVsbMYDUwNUBGJvbGQEdHJ1ZcQEOANUFjEzMTZ6bHBrbWN0b3FvbWdmdGhicGfGBE4DVARib2xkBG51bGzGAk0CTgZpdGFsaWMEdHJ1ZcYEUAJOBWNvbG9yBiIjODg4IsYCTwJQBml0YWxpYwRudWxsxgRSAlAFY29sb3IEbnVsbMYChAEChQEGaXRhbGljBHRydWXGBFQChQEFY29sb3IGIiM4ODgixgKGAQKHAQZpdGFsaWMEbnVsbMYEVgKHAQVjb2xvcgRudWxsxAMpAyoRMTMyMWFwZ2l2eWRxc2pmc2XFBBIDAm97ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn0zAwAEAQR0ZXh0AjEyhAMBAzkwboQDBAF4gQMFAoQDBwJyCsQDBAMFBjEyOTd6bcQDDwMFAXbEAxADBQFwwQMRAwUBxAMSAwUFa3pxY2rEAxcDBQJzYcQDGQMFBHNqeQrBAxIDEwHBAAwAEAHEAA0ADgkxMzAyeGNpd2HEAygADgF5xAMpAA4KaGhlenVraXF0dMQDMwAOBWhudGsKxgMoAykEYm9sZAR0cnVlxAM5AykGMTMwNXJswQM/AykCxANBAykDZXlrxgNEAykEYm9sZARudWxsxAMzAzQJMTMwN3R2amllwQNOAzQCxANQAzQDamxoxANTAzQCZ3bEA1UDNAJsYsQDVwM0AmYKxgNBA0IEYm9sZARudWxswQNaA0ICxANcA0ICMDjBA14DQgLEA2ADQgEKxgNhA0IEYm9sZAR0cnVlxQIaAhtveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9wQA3ADgCwQNlADgBxANmADgKMTVteml3YWJ6a8EDcAA4AsQDcgA4BnJybXNjdsEDeAA4AcQCYgJjATHEA3oCYwIzMsQDfAJjCTRyb3J5d3RoccQDhQECYwEKxAOFAQOGARkxMzI1aW9kYnppenhobWxpYnZweXJ4bXEKwQN6A3sBxgOgAQN7BWNvbG9yBiIjODg4IsYDfAN9Bml0YWxpYwRudWxsxgOiAQN9BWNvbG9yBG51bGxSAgAEAQR0ZXh0ATGEAgACMjiEAgIBOYECAwKEAgUBdYQCBgJ0Y4QCCAJqZYECCgKEAgwBaoECDQGBAg4BhAIPAnVmhAIRAQrEAg4CDwgxMjkycXJtZsQCGgIPAmsKxgIGAgcGaXRhbGljBHRydWXGAggCCQZpdGFsaWMEbnVsbMYCEQISBml0YWxpYwR0cnVlxAIfAhIBMcECIAISAsQCIgISAzRoc8QCJQISAXrGAiYCEgZpdGFsaWMEbnVsbMEAFQAWAsQCKQAWATDEAioAFgEwxAIrABYCaHjEAi0AFglvamVldHJqaHjBAjYAFgLEAjgAFgJrcsQCOgAWAXHBAjsAFgHBAjwAFgHEAj0AFgFuxAI+ABYCZQrGAiUCJgZpdGFsaWMEbnVsbMQCQQImAjEzwQJDAiYCxAJFAiYIZGNjeGR5eGfEAk0CJgJ6Y8QCTwImA2Fwb8QCUgImAnRuxAJUAiYBcsQCVQImAmduwQJXAiYCxAJZAiYBCsYCWgImBml0YWxpYwR0cnVlxAI6AjsEMTMwM8QCXwI7A3VodsQCYgI7BmdhbmxuCsUCVQJWb3siaW1hZ2UiOiJodHRwczovL3VzZXItaW1hZ2VzLmdpdGh1YnVzZXJjb250ZW50LmNvbS81NTUzNzU3LzQ4OTc1MzA3LTYxZWZiMTAwLWYwNmQtMTFlOC05MTc3LWVlODk1ZTU5MTZlNS5wbmcifcECPAI9AcECPgI/AcYDFwMYBml0YWxpYwR0cnVlxgJsAxgFY29sb3IGIiM4ODgixgMZAxoGaXRhbGljBG51bGzGAm4DGgVjb2xvcgRudWxswQMQBCkBxAJwBCkKMTMwOXpsZ3ZqeMQCegQpAWfBAnsEKQLGBA0EDgZpdGFsaWMEbnVsbMYCfgQOBWNvbG9yBG51bGzEAn8EDgUxMzEwZ8QChAEEDgJ3c8QChgEEDgZoeHd5Y2jEAowBBA4Ca3HEAo4BBA4Ec2RydcQCkgEEDgRqcWljwQKWAQQOBMQCmgEEDgEKxgKbAQQOBml0YWxpYwR0cnVlxgKcAQQOBWNvbG9yBiIjODg4IsECaAI7AcQCCgEBFjEzMThqd3NramFiZG5kcmRsbWphZQrGA1UDVgRib2xkBHRydWXGA1cDWARib2xkBG51bGzGAEAAQQZpdGFsaWMEdHJ1ZcYCtwEAQQRib2xkBG51bGzEArgBAEESMTMyNnJwY3pucWFob3BjcnRkxgLKAQBBBml0YWxpYwRudWxsxgLLAQBBBGJvbGQEdHJ1ZRkBAMUCAgIDb3siaW1hZ2UiOiJodHRwczovL3VzZXItaW1hZ2VzLmdpdGh1YnVzZXJjb250ZW50LmNvbS81NTUzNzU3LzQ4OTc1MzA3LTYxZWZiMTAwLWYwNmQtMTFlOC05MTc3LWVlODk1ZTU5MTZlNS5wbmcifcQCCgILBzEyOTN0agrGABgAGQRib2xkBHRydWXGAA0ADgRib2xkBG51bGxEAgAHMTMwNnJ1cMQBEAIAAnVqxAESAgANaWtrY2pucmNwc2Nrd8QBHwIAAQrFBBMEFG97ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn3FAx0DBW97ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn3GAlICUwRib2xkBHRydWXGAlQCVQRib2xkBG51bGzGAnsCfAZpdGFsaWMEdHJ1ZcYBJQJ8BWNvbG9yBiIjODg4IsYBJgJ8BGJvbGQEbnVsbMQBJwJ8CjEzMTRweWNhdnXGATECfAZpdGFsaWMEbnVsbMYBMgJ8BWNvbG9yBG51bGzBATMCfAHFADEAMm97ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn3GADUANgZpdGFsaWMEdHJ1ZcEANwA4AcQAMgAzEzEzMjJybmJhb2tvcml4ZW52cArEAgUCBhcxMzIzbnVjdnhzcWx6bndsZmF2bXBjCsYDDwMQBGJvbGQEdHJ1ZR0AAMQEAwQEDTEyOTVxZnJ2bHlmYXDEAAwEBAFjxAANBAQCanbBAAwADQHEABAADQEywQARAA0ExAAVAA0DZHZmxAAYAA0BYcYCAwIEBml0YWxpYwR0cnVlwQAaAgQCxAAcAgQEMDRrdcYAIAIEBml0YWxpYwRudWxsxQQgBCFveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9xQJAABZveyJpbWFnZSI6Imh0dHBzOi8vdXNlci1pbWFnZXMuZ2l0aHVidXNlcmNvbnRlbnQuY29tLzU1NTM3NTcvNDg5NzUzMDctNjFlZmIxMDAtZjA2ZC0xMWU4LTkxNzctZWU4OTVlNTkxNmU1LnBuZyJ9xAQVBBYGMTMxMWtrxAIqAisIMTMxMnFyd3TEADECKwFixAAyAisDcnhxxAA1AisBasQANgIrAXjEADcCKwZkb3ZhbwrEAgAEKwMxMzHEAEAEKwkzYXhoa3RoaHXGAnoCewRib2xkBG51bGzFAEoCe297ImltYWdlIjoiaHR0cHM6Ly91c2VyLWltYWdlcy5naXRodWJ1c2VyY29udGVudC5jb20vNTU1Mzc1Ny80ODk3NTMwNy02MWVmYjEwMC1mMDZkLTExZTgtOTE3Ny1lZTg5NWU1OTE2ZTUucG5nIn3GAEsCewRib2xkBHRydWXEAl8CYBExMzE3cGZjeWhrc3JrcGt0CsQBHwQqCzEzMTliY2Nna3AKxAKSAQKTARUxMzIwY29oYnZjcmtycGpuZ2RvYwoFBAQCAg8CKQE1AQADEAESBBsCAwsGAhIBHgJAAk8CWwJfAmQDcQJ5AaABAQIOBAILAg4CIQIoAjcCPAJEAlgCagJwAXwClwEEngEBAQI0ATcB';
  // eslint-disable-next-line
  const oldVal = [{"insert":"1306rup"},{"insert":"uj","attributes":{"italic":true,"color":"#888"}},{"insert":"ikkcjnrcpsckw1319bccgkp\n"},{"insert":"\n1131","attributes":{"bold":true}},{"insert":"1326rpcznqahopcrtd","attributes":{"italic":true}},{"insert":"3axhkthhu","attributes":{"bold":true}},{"insert":"28"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"9"},{"insert":"04ku","attributes":{"italic":true}},{"insert":"1323nucvxsqlznwlfavmpc\nu"},{"insert":"tc","attributes":{"italic":true}},{"insert":"je1318jwskjabdndrdlmjae\n1293tj\nj1292qrmf"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"k\nuf"},{"insert":"14hs","attributes":{"italic":true}},{"insert":"13dccxdyxg"},{"insert":"zc","attributes":{"italic":true,"color":"#888"}},{"insert":"apo"},{"insert":"tn","attributes":{"bold":true}},{"insert":"r"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"gn\n"},{"insert":"z","attributes":{"italic":true}},{"insert":"\n121"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"291311kk9zjznywohpx"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"cnbrcaq\n"},{"insert":"1","attributes":{"italic":true,"color":"#888"}},{"insert":"1310g"},{"insert":"ws","attributes":{"italic":true,"color":"#888"}},{"insert":"hxwych"},{"insert":"kq","attributes":{"italic":true}},{"insert":"sdru1320cohbvcrkrpjngdoc\njqic\n"},{"insert":"2","attributes":{"italic":true,"color":"#888"}},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"90n1297zm"},{"insert":"v1309zlgvjx","attributes":{"bold":true}},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"g","attributes":{"bold":true}},{"insert":"1314pycavu","attributes":{"italic":true,"color":"#888"}},{"insert":"pkzqcj"},{"insert":"sa","attributes":{"italic":true,"color":"#888"}},{"insert":"sjy\n"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"xr\n"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"1"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"1295qfrvlyfap201312qrwt"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"b1322rnbaokorixenvp\nrxq"},{"insert":"j","attributes":{"italic":true}},{"insert":"x","attributes":{"italic":true,"color":"#888"}},{"insert":"15mziwabzkrrmscvdovao\n0","attributes":{"italic":true}},{"insert":"hx","attributes":{"italic":true,"bold":true}},{"insert":"ojeetrjhxkr13031317pfcyhksrkpkt\nuhv1","attributes":{"italic":true}},{"insert":"32","attributes":{"italic":true,"color":"#888"}},{"insert":"4rorywthq1325iodbzizxhmlibvpyrxmq\n\nganln\nqne\n"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}},{"insert":"dvf"},{"insert":"ac","attributes":{"bold":true}},{"insert":"1302xciwa"},{"insert":"1305rl","attributes":{"bold":true}},{"insert":"08\n"},{"insert":"eyk","attributes":{"bold":true}},{"insert":"y1321apgivydqsjfsehhezukiqtt1307tvjiejlh"},{"insert":"1316zlpkmctoqomgfthbpg","attributes":{"bold":true}},{"insert":"gv"},{"insert":"lb","attributes":{"bold":true}},{"insert":"f\nhntk\njv1uu\n"},{"insert":{"image":"https://user-images.githubusercontent.com/5553757/48975307-61efb100-f06d-11e8-9177-ee895e5916e5.png"}}];
  const doc = new Doc();
  applyUpdate(doc, buffer__namespace.fromBase64(oldDoc));
  t__namespace.compare(doc.getText('text').toDelta(), oldVal);
};

var compatibility = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testArrayCompatibilityV1: testArrayCompatibilityV1,
  testMapDecodingCompatibilityV1: testMapDecodingCompatibilityV1,
  testTextDecodingCompatibilityV1: testTextDecodingCompatibilityV1
});

/**
 * @param {t.TestCase} _tc
 */
const testAfterTransactionRecursion = _tc => {
  const ydoc = new Doc();
  const yxml = ydoc.getXmlFragment('');
  ydoc.on('afterTransaction', tr => {
    if (tr.origin === 'test') {
      yxml.toJSON();
    }
  });
  ydoc.transact(_tr => {
    for (let i = 0; i < 15000; i++) {
      yxml.push([new YXmlText('a')]);
    }
  }, 'test');
};

/**
 * @param {t.TestCase} _tc
 */
const testOriginInTransaction = _tc => {
  const doc = new Doc();
  const ytext = doc.getText();
  /**
   * @type {Array<string>}
   */
  const origins = [];
  doc.on('afterTransaction', (tr) => {
    origins.push(tr.origin);
    if (origins.length <= 1) {
      ytext.toDelta(snapshot$1(doc)); // adding a snapshot forces toDelta to create a cleanup transaction
      doc.transact(() => {
        ytext.insert(0, 'a');
      }, 'nested');
    }
  });
  doc.transact(() => {
    ytext.insert(0, '0');
  }, 'first');
  t__namespace.compareArrays(origins, ['first', 'cleanup', 'nested']);
};

/**
 * Client id should be changed when an instance receives updates from another client using the same client id.
 *
 * @param {t.TestCase} _tc
 */
const testClientIdDuplicateChange = _tc => {
  const doc1 = new Doc();
  doc1.clientID = 0;
  const doc2 = new Doc();
  doc2.clientID = 0;
  t__namespace.assert(doc2.clientID === doc1.clientID);
  doc1.getArray('a').insert(0, [1, 2]);
  applyUpdate(doc2, encodeStateAsUpdate(doc1));
  t__namespace.assert(doc2.clientID !== doc1.clientID);
};

/**
 * @param {t.TestCase} _tc
 */
const testGetTypeEmptyId = _tc => {
  const doc1 = new Doc();
  doc1.getText('').insert(0, 'h');
  doc1.getText().insert(1, 'i');
  const doc2 = new Doc();
  applyUpdate(doc2, encodeStateAsUpdate(doc1));
  t__namespace.assert(doc2.getText().toString() === 'hi');
  t__namespace.assert(doc2.getText('').toString() === 'hi');
};

/**
 * @param {t.TestCase} _tc
 */
const testToJSON = _tc => {
  const doc = new Doc();
  t__namespace.compare(doc.toJSON(), {}, 'doc.toJSON yields empty object');

  const arr = doc.getArray('array');
  arr.push(['test1']);

  const map = doc.getMap('map');
  map.set('k1', 'v1');
  const map2 = new YMap();
  map.set('k2', map2);
  map2.set('m2k1', 'm2v1');

  t__namespace.compare(doc.toJSON(), {
    array: ['test1'],
    map: {
      k1: 'v1',
      k2: {
        m2k1: 'm2v1'
      }
    }
  }, 'doc.toJSON has array and recursive map');
};

/**
 * @param {t.TestCase} _tc
 */
const testSubdoc = _tc => {
  const doc = new Doc();
  doc.load(); // doesn't do anything
  {
    /**
     * @type {Array<any>|null}
     */
    let event = /** @type {any} */ (null);
    doc.on('subdocs', subdocs => {
      event = [Array.from(subdocs.added).map(x => x.guid), Array.from(subdocs.removed).map(x => x.guid), Array.from(subdocs.loaded).map(x => x.guid)];
    });
    const subdocs = doc.getMap('mysubdocs');
    const docA = new Doc({ guid: 'a' });
    docA.load();
    subdocs.set('a', docA);
    t__namespace.compare(event, [['a'], [], ['a']]);

    event = null;
    subdocs.get('a').load();
    t__namespace.assert(event === null);

    event = null;
    subdocs.get('a').destroy();
    t__namespace.compare(event, [['a'], ['a'], []]);
    subdocs.get('a').load();
    t__namespace.compare(event, [[], [], ['a']]);

    subdocs.set('b', new Doc({ guid: 'a', shouldLoad: false }));
    t__namespace.compare(event, [['a'], [], []]);
    subdocs.get('b').load();
    t__namespace.compare(event, [[], [], ['a']]);

    const docC = new Doc({ guid: 'c' });
    docC.load();
    subdocs.set('c', docC);
    t__namespace.compare(event, [['c'], [], ['c']]);

    t__namespace.compare(Array.from(doc.getSubdocGuids()), ['a', 'c']);
  }

  const doc2 = new Doc();
  {
    t__namespace.compare(Array.from(doc2.getSubdocs()), []);
    /**
     * @type {Array<any>|null}
     */
    let event = /** @type {any} */ (null);
    doc2.on('subdocs', subdocs => {
      event = [Array.from(subdocs.added).map(d => d.guid), Array.from(subdocs.removed).map(d => d.guid), Array.from(subdocs.loaded).map(d => d.guid)];
    });
    applyUpdate(doc2, encodeStateAsUpdate(doc));
    t__namespace.compare(event, [['a', 'a', 'c'], [], []]);

    doc2.getMap('mysubdocs').get('a').load();
    t__namespace.compare(event, [[], [], ['a']]);

    t__namespace.compare(Array.from(doc2.getSubdocGuids()), ['a', 'c']);

    doc2.getMap('mysubdocs').delete('a');
    t__namespace.compare(event, [[], ['a'], []]);
    t__namespace.compare(Array.from(doc2.getSubdocGuids()), ['a', 'c']);
  }
};

/**
 * @param {t.TestCase} _tc
 */
const testSubdocLoadEdgeCases = _tc => {
  const ydoc = new Doc();
  const yarray = ydoc.getArray();
  const subdoc1 = new Doc();
  /**
   * @type {any}
   */
  let lastEvent = null;
  ydoc.on('subdocs', event => {
    lastEvent = event;
  });
  yarray.insert(0, [subdoc1]);
  t__namespace.assert(subdoc1.shouldLoad);
  t__namespace.assert(subdoc1.autoLoad === false);
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc1));
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc1));
  // destroy and check whether lastEvent adds it again to added (it shouldn't)
  subdoc1.destroy();
  const subdoc2 = yarray.get(0);
  t__namespace.assert(subdoc1 !== subdoc2);
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc2));
  t__namespace.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc2));
  // load
  subdoc2.load();
  t__namespace.assert(lastEvent !== null && !lastEvent.added.has(subdoc2));
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc2));
  // apply from remote
  const ydoc2 = new Doc();
  ydoc2.on('subdocs', event => {
    lastEvent = event;
  });
  applyUpdate(ydoc2, encodeStateAsUpdate(ydoc));
  const subdoc3 = ydoc2.getArray().get(0);
  t__namespace.assert(subdoc3.shouldLoad === false);
  t__namespace.assert(subdoc3.autoLoad === false);
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc3));
  t__namespace.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc3));
  // load
  subdoc3.load();
  t__namespace.assert(subdoc3.shouldLoad);
  t__namespace.assert(lastEvent !== null && !lastEvent.added.has(subdoc3));
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc3));
};

/**
 * @param {t.TestCase} _tc
 */
const testSubdocLoadEdgeCasesAutoload = _tc => {
  const ydoc = new Doc();
  const yarray = ydoc.getArray();
  const subdoc1 = new Doc({ autoLoad: true });
  /**
   * @type {any}
   */
  let lastEvent = null;
  ydoc.on('subdocs', event => {
    lastEvent = event;
  });
  yarray.insert(0, [subdoc1]);
  t__namespace.assert(subdoc1.shouldLoad);
  t__namespace.assert(subdoc1.autoLoad);
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc1));
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc1));
  // destroy and check whether lastEvent adds it again to added (it shouldn't)
  subdoc1.destroy();
  const subdoc2 = yarray.get(0);
  t__namespace.assert(subdoc1 !== subdoc2);
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc2));
  t__namespace.assert(lastEvent !== null && !lastEvent.loaded.has(subdoc2));
  // load
  subdoc2.load();
  t__namespace.assert(lastEvent !== null && !lastEvent.added.has(subdoc2));
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc2));
  // apply from remote
  const ydoc2 = new Doc();
  ydoc2.on('subdocs', event => {
    lastEvent = event;
  });
  applyUpdate(ydoc2, encodeStateAsUpdate(ydoc));
  const subdoc3 = ydoc2.getArray().get(0);
  t__namespace.assert(subdoc1.shouldLoad);
  t__namespace.assert(subdoc1.autoLoad);
  t__namespace.assert(lastEvent !== null && lastEvent.added.has(subdoc3));
  t__namespace.assert(lastEvent !== null && lastEvent.loaded.has(subdoc3));
};

/**
 * @param {t.TestCase} _tc
 */
const testSubdocsUndo = _tc => {
  const ydoc = new Doc();
  const elems = ydoc.getXmlFragment();
  const undoManager = new UndoManager(elems);
  const subdoc = new Doc();
  // @ts-ignore
  elems.insert(0, [subdoc]);
  undoManager.undo();
  undoManager.redo();
  t__namespace.assert(elems.length === 1);
};

/**
 * @param {t.TestCase} _tc
 */
const testLoadDocsEvent = async _tc => {
  const ydoc = new Doc();
  t__namespace.assert(ydoc.isLoaded === false);
  let loadedEvent = false;
  ydoc.on('load', () => {
    loadedEvent = true;
  });
  ydoc.emit('load', [ydoc]);
  await ydoc.whenLoaded;
  t__namespace.assert(loadedEvent);
  t__namespace.assert(ydoc.isLoaded);
};

/**
 * @param {t.TestCase} _tc
 */
const testSyncDocsEvent = async _tc => {
  const ydoc = new Doc();
  t__namespace.assert(ydoc.isLoaded === false);
  t__namespace.assert(ydoc.isSynced === false);
  let loadedEvent = false;
  ydoc.once('load', () => {
    loadedEvent = true;
  });
  let syncedEvent = false;
  ydoc.once('sync', /** @param {any} isSynced */ (isSynced) => {
    syncedEvent = true;
    t__namespace.assert(isSynced);
  });
  ydoc.emit('sync', [true, ydoc]);
  await ydoc.whenLoaded;
  const oldWhenSynced = ydoc.whenSynced;
  await ydoc.whenSynced;
  t__namespace.assert(loadedEvent);
  t__namespace.assert(syncedEvent);
  t__namespace.assert(ydoc.isLoaded);
  t__namespace.assert(ydoc.isSynced);
  let loadedEvent2 = false;
  ydoc.on('load', () => {
    loadedEvent2 = true;
  });
  let syncedEvent2 = false;
  ydoc.on('sync', (isSynced) => {
    syncedEvent2 = true;
    t__namespace.assert(isSynced === false);
  });
  ydoc.emit('sync', [false, ydoc]);
  t__namespace.assert(!loadedEvent2);
  t__namespace.assert(syncedEvent2);
  t__namespace.assert(ydoc.isLoaded);
  t__namespace.assert(!ydoc.isSynced);
  t__namespace.assert(ydoc.whenSynced !== oldWhenSynced);
};

var doc = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testAfterTransactionRecursion: testAfterTransactionRecursion,
  testClientIdDuplicateChange: testClientIdDuplicateChange,
  testGetTypeEmptyId: testGetTypeEmptyId,
  testLoadDocsEvent: testLoadDocsEvent,
  testOriginInTransaction: testOriginInTransaction,
  testSubdoc: testSubdoc,
  testSubdocLoadEdgeCases: testSubdocLoadEdgeCases,
  testSubdocLoadEdgeCasesAutoload: testSubdocLoadEdgeCasesAutoload,
  testSubdocsUndo: testSubdocsUndo,
  testSyncDocsEvent: testSyncDocsEvent,
  testToJSON: testToJSON
});

/**
 * @param {t.TestCase} _tc
 */
const testBasic = _tc => {
  const ydoc = new Doc({ gc: false });
  ydoc.getText().insert(0, 'world!');
  const snapshot = snapshot$1(ydoc);
  ydoc.getText().insert(0, 'hello ');
  const restored = createDocFromSnapshot(ydoc, snapshot);
  t__namespace.assert(restored.getText().toString() === 'world!');
};

/**
 * @param {t.TestCase} _tc
 */
const testBasicXmlAttributes = _tc => {
  const ydoc = new Doc({ gc: false });
  const yxml = ydoc.getMap().set('el', new YXmlElement('div'));
  const snapshot1 = snapshot$1(ydoc);
  yxml.setAttribute('a', '1');
  const snapshot2 = snapshot$1(ydoc);
  yxml.setAttribute('a', '2');
  t__namespace.compare(yxml.getAttributes(), { a: '2' });
  t__namespace.compare(yxml.getAttributes(snapshot2), { a: '1' });
  t__namespace.compare(yxml.getAttributes(snapshot1), {});
};

/**
 * @param {t.TestCase} _tc
 */
const testBasicRestoreSnapshot = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, ['hello']);
  const snap = snapshot$1(doc);
  doc.getArray('array').insert(1, ['world']);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toArray(), ['hello']);
  t__namespace.compare(doc.getArray('array').toArray(), ['hello', 'world']);
};

/**
 * @param {t.TestCase} _tc
 */
const testEmptyRestoreSnapshot = _tc => {
  const doc = new Doc({ gc: false });
  const snap = snapshot$1(doc);
  snap.sv.set(9999, 0);
  doc.getArray().insert(0, ['world']);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray().toArray(), []);
  t__namespace.compare(doc.getArray().toArray(), ['world']);

  // now this snapshot reflects the latest state. It shoult still work.
  const snap2 = snapshot$1(doc);
  const docRestored2 = createDocFromSnapshot(doc, snap2);
  t__namespace.compare(docRestored2.getArray().toArray(), ['world']);
};

/**
 * @param {t.TestCase} _tc
 */
const testRestoreSnapshotWithSubType = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, [new YMap()]);
  const subMap = doc.getArray('array').get(0);
  subMap.set('key1', 'value1');

  const snap = snapshot$1(doc);
  subMap.set('key2', 'value2');

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toJSON(), [{
    key1: 'value1'
  }]);
  t__namespace.compare(doc.getArray('array').toJSON(), [{
    key1: 'value1',
    key2: 'value2'
  }]);
};

/**
 * @param {t.TestCase} _tc
 */
const testRestoreDeletedItem1 = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, ['item1', 'item2']);

  const snap = snapshot$1(doc);
  doc.getArray('array').delete(0);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toArray(), ['item1', 'item2']);
  t__namespace.compare(doc.getArray('array').toArray(), ['item2']);
};

/**
 * @param {t.TestCase} _tc
 */
const testRestoreLeftItem = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, ['item1']);
  doc.getMap('map').set('test', 1);
  doc.getArray('array').insert(0, ['item0']);

  const snap = snapshot$1(doc);
  doc.getArray('array').delete(1);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toArray(), ['item0', 'item1']);
  t__namespace.compare(doc.getArray('array').toArray(), ['item0']);
};

/**
 * @param {t.TestCase} _tc
 */
const testDeletedItemsBase = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, ['item1']);
  doc.getArray('array').delete(0);
  const snap = snapshot$1(doc);
  doc.getArray('array').insert(0, ['item0']);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toArray(), []);
  t__namespace.compare(doc.getArray('array').toArray(), ['item0']);
};

/**
 * @param {t.TestCase} _tc
 */
const testDeletedItems2 = _tc => {
  const doc = new Doc({ gc: false });
  doc.getArray('array').insert(0, ['item1', 'item2', 'item3']);
  doc.getArray('array').delete(1);
  const snap = snapshot$1(doc);
  doc.getArray('array').insert(0, ['item0']);

  const docRestored = createDocFromSnapshot(doc, snap);

  t__namespace.compare(docRestored.getArray('array').toArray(), ['item1', 'item3']);
  t__namespace.compare(doc.getArray('array').toArray(), ['item0', 'item1', 'item3']);
};

/**
 * @param {t.TestCase} tc
 */
const testDependentChanges = tc => {
  const { array0, array1, testConnector } = init$1(tc, { users: 2 });

  if (!array0.doc) {
    throw new Error('no document 0')
  }
  if (!array1.doc) {
    throw new Error('no document 1')
  }

  /**
   * @type {Y.Doc}
   */
  const doc0 = array0.doc;
  /**
   * @type {Y.Doc}
   */
  const doc1 = array1.doc;

  doc0.gc = false;
  doc1.gc = false;

  array0.insert(0, ['user1item1']);
  testConnector.syncAll();
  array1.insert(1, ['user2item1']);
  testConnector.syncAll();

  const snap = snapshot$1(array0.doc);

  array0.insert(2, ['user1item2']);
  testConnector.syncAll();
  array1.insert(3, ['user2item2']);
  testConnector.syncAll();

  const docRestored0 = createDocFromSnapshot(array0.doc, snap);
  t__namespace.compare(docRestored0.getArray('array').toArray(), ['user1item1', 'user2item1']);

  const docRestored1 = createDocFromSnapshot(array1.doc, snap);
  t__namespace.compare(docRestored1.getArray('array').toArray(), ['user1item1', 'user2item1']);
};

/**
 * @param {t.TestCase} _tc
 */
const testContainsUpdate = _tc => {
  const ydoc = new Doc();
  /**
   * @type {Array<Uint8Array>}
   */
  const updates = [];
  ydoc.on('update', update => {
    updates.push(update);
  });
  const yarr = ydoc.getArray();
  const snapshot1 = snapshot$1(ydoc);
  yarr.insert(0, [1]);
  const snapshot2 = snapshot$1(ydoc);
  yarr.delete(0, 1);
  const snapshotFinal = snapshot$1(ydoc);
  t__namespace.assert(!snapshotContainsUpdate(snapshot1, updates[0]));
  t__namespace.assert(!snapshotContainsUpdate(snapshot2, updates[1]));
  t__namespace.assert(snapshotContainsUpdate(snapshot2, updates[0]));
  t__namespace.assert(snapshotContainsUpdate(snapshotFinal, updates[0]));
  t__namespace.assert(snapshotContainsUpdate(snapshotFinal, updates[1]));
};

var snapshot = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testBasic: testBasic,
  testBasicRestoreSnapshot: testBasicRestoreSnapshot,
  testBasicXmlAttributes: testBasicXmlAttributes,
  testContainsUpdate: testContainsUpdate,
  testDeletedItems2: testDeletedItems2,
  testDeletedItemsBase: testDeletedItemsBase,
  testDependentChanges: testDependentChanges,
  testEmptyRestoreSnapshot: testEmptyRestoreSnapshot,
  testRestoreDeletedItem1: testRestoreDeletedItem1,
  testRestoreLeftItem: testRestoreLeftItem,
  testRestoreSnapshotWithSubType: testRestoreSnapshotWithSubType
});

/**
 * @typedef {Object} Enc
 * @property {function(Array<Uint8Array>):Uint8Array} Enc.mergeUpdates
 * @property {function(Y.Doc):Uint8Array} Enc.encodeStateAsUpdate
 * @property {function(Y.Doc, Uint8Array):void} Enc.applyUpdate
 * @property {function(Uint8Array):void} Enc.logUpdate
 * @property {function(Uint8Array):{from:Map<number,number>,to:Map<number,number>}} Enc.parseUpdateMeta
 * @property {function(Y.Doc):Uint8Array} Enc.encodeStateVector
 * @property {function(Uint8Array):Uint8Array} Enc.encodeStateVectorFromUpdate
 * @property {'update'|'updateV2'} Enc.updateEventName
 * @property {string} Enc.description
 * @property {function(Uint8Array, Uint8Array):Uint8Array} Enc.diffUpdate
 */

/**
 * @type {Enc}
 */
const encV1 = {
  mergeUpdates: mergeUpdates,
  encodeStateAsUpdate: encodeStateAsUpdate,
  applyUpdate: applyUpdate,
  logUpdate: logUpdate,
  parseUpdateMeta: parseUpdateMeta,
  encodeStateVectorFromUpdate: encodeStateVectorFromUpdate,
  encodeStateVector: encodeStateVector,
  updateEventName: 'update',
  description: 'V1',
  diffUpdate: diffUpdate
};

/**
 * @type {Enc}
 */
const encV2 = {
  mergeUpdates: mergeUpdatesV2,
  encodeStateAsUpdate: encodeStateAsUpdateV2,
  applyUpdate: applyUpdateV2,
  logUpdate: logUpdateV2,
  parseUpdateMeta: parseUpdateMetaV2,
  encodeStateVectorFromUpdate: encodeStateVectorFromUpdateV2,
  encodeStateVector: encodeStateVector,
  updateEventName: 'updateV2',
  description: 'V2',
  diffUpdate: diffUpdateV2
};

/**
 * @type {Enc}
 */
const encDoc = {
  mergeUpdates: (updates) => {
    const ydoc = new Doc({ gc: false });
    updates.forEach(update => {
      applyUpdateV2(ydoc, update);
    });
    return encodeStateAsUpdateV2(ydoc)
  },
  encodeStateAsUpdate: encodeStateAsUpdateV2,
  applyUpdate: applyUpdateV2,
  logUpdate: logUpdateV2,
  parseUpdateMeta: parseUpdateMetaV2,
  encodeStateVectorFromUpdate: encodeStateVectorFromUpdateV2,
  encodeStateVector: encodeStateVector,
  updateEventName: 'updateV2',
  description: 'Merge via Y.Doc',
  /**
   * @param {Uint8Array} update
   * @param {Uint8Array} sv
   */
  diffUpdate: (update, sv) => {
    const ydoc = new Doc({ gc: false });
    applyUpdateV2(ydoc, update);
    return encodeStateAsUpdateV2(ydoc, sv)
  }
};

const encoders = [encV1, encV2, encDoc];

/**
 * @param {Array<Y.Doc>} users
 * @param {Enc} enc
 */
const fromUpdates = (users, enc) => {
  const updates = users.map(user =>
    enc.encodeStateAsUpdate(user)
  );
  const ydoc = new Doc();
  enc.applyUpdate(ydoc, enc.mergeUpdates(updates));
  return ydoc
};

/**
 * @param {t.TestCase} tc
 */
const testMergeUpdates = tc => {
  const { users, array0, array1 } = init$1(tc, { users: 3 });

  array0.insert(0, [1]);
  array1.insert(0, [2]);

  compare$1(users);
  encoders.forEach(enc => {
    const merged = fromUpdates(users, enc);
    t__namespace.compareArrays(array0.toArray(), merged.getArray('array').toArray());
  });
};

/**
 * @param {t.TestCase} tc
 */
const testKeyEncoding = tc => {
  const { users, text0, text1 } = init$1(tc, { users: 2 });

  text0.insert(0, 'a', { italic: true });
  text0.insert(0, 'b');
  text0.insert(0, 'c', { italic: true });

  const update = encodeStateAsUpdateV2(users[0]);
  applyUpdateV2(users[1], update);

  t__namespace.compare(text1.toDelta(), [{ insert: 'c', attributes: { italic: true } }, { insert: 'b' }, { insert: 'a', attributes: { italic: true } }]);

  compare$1(users);
};

/**
 * @param {Y.Doc} ydoc
 * @param {Array<Uint8Array>} updates - expecting at least 4 updates
 * @param {Enc} enc
 * @param {boolean} hasDeletes
 */
const checkUpdateCases = (ydoc, updates, enc, hasDeletes) => {
  const cases = [];
  // Case 1: Simple case, simply merge everything
  cases.push(enc.mergeUpdates(updates));

  // Case 2: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(0, 2))
  ]));

  // Case 3: Overlapping updates
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates(updates.slice(2)),
    enc.mergeUpdates(updates.slice(1, 3)),
    updates[0]
  ]));

  // Case 4: Separated updates (containing skips)
  cases.push(enc.mergeUpdates([
    enc.mergeUpdates([updates[0], updates[2]]),
    enc.mergeUpdates([updates[1], updates[3]]),
    enc.mergeUpdates(updates.slice(4))
  ]));

  // Case 5: overlapping with many duplicates
  cases.push(enc.mergeUpdates(cases));

  // const targetState = enc.encodeStateAsUpdate(ydoc)
  // t.info('Target State: ')
  // enc.logUpdate(targetState)

  cases.forEach((mergedUpdates) => {
    // t.info('State Case $' + i + ':')
    // enc.logUpdate(updates)
    const merged = new Doc({ gc: false });
    enc.applyUpdate(merged, mergedUpdates);
    t__namespace.compareArrays(merged.getArray().toArray(), ydoc.getArray().toArray());
    t__namespace.compare(enc.encodeStateVector(merged), enc.encodeStateVectorFromUpdate(mergedUpdates));

    if (enc.updateEventName !== 'update') { // @todo should this also work on legacy updates?
      for (let j = 1; j < updates.length; j++) {
        const partMerged = enc.mergeUpdates(updates.slice(j));
        const partMeta = enc.parseUpdateMeta(partMerged);
        const targetSV = encodeStateVectorFromUpdateV2(mergeUpdatesV2(updates.slice(0, j)));
        const diffed = enc.diffUpdate(mergedUpdates, targetSV);
        const diffedMeta = enc.parseUpdateMeta(diffed);
        t__namespace.compare(partMeta, diffedMeta);
        {
          // We can'd do the following
          //  - t.compare(diffed, mergedDeletes)
          // because diffed contains the set of all deletes.
          // So we add all deletes from `diffed` to `partDeletes` and compare then
          const decoder = decoding__namespace.createDecoder(diffed);
          const updateDecoder = new UpdateDecoderV2(decoder);
          readClientsStructRefs(updateDecoder, new Doc());
          const ds = readDeleteSet(updateDecoder);
          const updateEncoder = new UpdateEncoderV2();
          encoding__namespace.writeVarUint(updateEncoder.restEncoder, 0); // 0 structs
          writeDeleteSet(updateEncoder, ds);
          const deletesUpdate = updateEncoder.toUint8Array();
          const mergedDeletes = mergeUpdatesV2([deletesUpdate, partMerged]);
          if (!hasDeletes || enc !== encDoc) {
            // deletes will almost definitely lead to different encoders because of the mergeStruct feature that is present in encDoc
            t__namespace.compare(diffed, mergedDeletes);
          }
        }
      }
    }

    const meta = enc.parseUpdateMeta(mergedUpdates);
    meta.from.forEach((clock, client) => t__namespace.assert(clock === 0));
    meta.to.forEach((clock, client) => {
      const structs = /** @type {Array<Y.Item>} */ (merged.store.clients.get(client));
      const lastStruct = structs[structs.length - 1];
      t__namespace.assert(lastStruct.id.clock + lastStruct.length === clock);
    });
  });
};

/**
 * @param {t.TestCase} _tc
 */
const testMergeUpdates1 = _tc => {
  encoders.forEach((enc) => {
    t__namespace.info(`Using encoder: ${enc.description}`);
    const ydoc = new Doc({ gc: false });
    const updates = /** @type {Array<Uint8Array>} */ ([]);
    ydoc.on(enc.updateEventName, update => { updates.push(update); });

    const array = ydoc.getArray();
    array.insert(0, [1]);
    array.insert(0, [2]);
    array.insert(0, [3]);
    array.insert(0, [4]);

    checkUpdateCases(ydoc, updates, enc, false);
  });
};

/**
 * @param {t.TestCase} tc
 */
const testMergeUpdates2 = tc => {
  encoders.forEach((enc, i) => {
    t__namespace.info(`Using encoder: ${enc.description}`);
    const ydoc = new Doc({ gc: false });
    const updates = /** @type {Array<Uint8Array>} */ ([]);
    ydoc.on(enc.updateEventName, update => { updates.push(update); });

    const array = ydoc.getArray();
    array.insert(0, [1, 2]);
    array.delete(1, 1);
    array.insert(0, [3, 4]);
    array.delete(1, 2);

    checkUpdateCases(ydoc, updates, enc, true);
  });
};

/**
 * @param {t.TestCase} tc
 */
const testMergePendingUpdates = tc => {
  const yDoc = new Doc();
  /**
   * @type {Array<Uint8Array>}
   */
  const serverUpdates = [];
  yDoc.on('update', (update, origin, c) => {
    serverUpdates.splice(serverUpdates.length, 0, update);
  });
  const yText = yDoc.getText('textBlock');
  yText.applyDelta([{ insert: 'r' }]);
  yText.applyDelta([{ insert: 'o' }]);
  yText.applyDelta([{ insert: 'n' }]);
  yText.applyDelta([{ insert: 'e' }]);
  yText.applyDelta([{ insert: 'n' }]);

  const yDoc1 = new Doc();
  applyUpdate(yDoc1, serverUpdates[0]);
  const update1 = encodeStateAsUpdate(yDoc1);

  const yDoc2 = new Doc();
  applyUpdate(yDoc2, update1);
  applyUpdate(yDoc2, serverUpdates[1]);
  const update2 = encodeStateAsUpdate(yDoc2);

  const yDoc3 = new Doc();
  applyUpdate(yDoc3, update2);
  applyUpdate(yDoc3, serverUpdates[3]);
  const update3 = encodeStateAsUpdate(yDoc3);

  const yDoc4 = new Doc();
  applyUpdate(yDoc4, update3);
  applyUpdate(yDoc4, serverUpdates[2]);
  const update4 = encodeStateAsUpdate(yDoc4);

  const yDoc5 = new Doc();
  applyUpdate(yDoc5, update4);
  applyUpdate(yDoc5, serverUpdates[4]);
  // @ts-ignore
  encodeStateAsUpdate(yDoc5); // eslint-disable-line

  const yText5 = yDoc5.getText('textBlock');
  t__namespace.compareStrings(yText5.toString(), 'nenor');
};

/**
 * @param {t.TestCase} _tc
 */
const testObfuscateUpdates = _tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText('text');
  const ymap = ydoc.getMap('map');
  const yarray = ydoc.getArray('array');
  // test ytext
  ytext.applyDelta([{ insert: 'text', attributes: { bold: true } }, { insert: { href: 'supersecreturl' } }]);
  // test ymap
  ymap.set('key', 'secret1');
  ymap.set('key', 'secret2');
  // test yarray with subtype & subdoc
  const subtype = new YXmlElement('secretnodename');
  const subdoc = new Doc({ guid: 'secret' });
  subtype.setAttribute('attr', 'val');
  yarray.insert(0, ['teststring', 42, subtype, subdoc]);
  // obfuscate the content and put it into a new document
  const obfuscatedUpdate = obfuscateUpdate(encodeStateAsUpdate(ydoc));
  const odoc = new Doc();
  applyUpdate(odoc, obfuscatedUpdate);
  const otext = odoc.getText('text');
  const omap = odoc.getMap('map');
  const oarray = odoc.getArray('array');
  // test ytext
  const delta = otext.toDelta();
  t__namespace.assert(delta.length === 2);
  t__namespace.assert(delta[0].insert !== 'text' && delta[0].insert.length === 4);
  t__namespace.assert(object__namespace.length(delta[0].attributes) === 1);
  t__namespace.assert(!object__namespace.hasProperty(delta[0].attributes, 'bold'));
  t__namespace.assert(object__namespace.length(delta[1]) === 1);
  t__namespace.assert(object__namespace.hasProperty(delta[1], 'insert'));
  // test ymap
  t__namespace.assert(omap.size === 1);
  t__namespace.assert(!omap.has('key'));
  // test yarray with subtype & subdoc
  const result = oarray.toArray();
  t__namespace.assert(result.length === 4);
  t__namespace.assert(result[0] !== 'teststring');
  t__namespace.assert(result[1] !== 42);
  const osubtype = /** @type {Y.XmlElement} */ (result[2]);
  const osubdoc = result[3];
  // test subtype
  t__namespace.assert(osubtype.nodeName !== subtype.nodeName);
  t__namespace.assert(object__namespace.length(osubtype.getAttributes()) === 1);
  t__namespace.assert(osubtype.getAttribute('attr') === undefined);
  // test subdoc
  t__namespace.assert(osubdoc.guid !== subdoc.guid);
};

var updates = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testKeyEncoding: testKeyEncoding,
  testMergePendingUpdates: testMergePendingUpdates,
  testMergeUpdates: testMergeUpdates,
  testMergeUpdates1: testMergeUpdates1,
  testMergeUpdates2: testMergeUpdates2,
  testObfuscateUpdates: testObfuscateUpdates
});

/**
 * @param {Y.Text} ytext
 */
const checkRelativePositions = ytext => {
  // test if all positions are encoded and restored correctly
  for (let i = 0; i < ytext.length; i++) {
    // for all types of associations..
    for (let assoc = -1; assoc < 2; assoc++) {
      const rpos = createRelativePositionFromTypeIndex(ytext, i, assoc);
      const encodedRpos = encodeRelativePosition(rpos);
      const decodedRpos = decodeRelativePosition(encodedRpos);
      const absPos = /** @type {Y.AbsolutePosition} */ (createAbsolutePositionFromRelativePosition(decodedRpos, /** @type {Y.Doc} */ (ytext.doc)));
      t__namespace.assert(absPos.index === i);
      t__namespace.assert(absPos.assoc === assoc);
    }
  }
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase1 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, '1');
  ytext.insert(0, 'abc');
  ytext.insert(0, 'z');
  ytext.insert(0, 'y');
  ytext.insert(0, 'x');
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase2 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, 'abc');
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase3 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, 'abc');
  ytext.insert(0, '1');
  ytext.insert(0, 'xyz');
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase4 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, '1');
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase5 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, '2');
  ytext.insert(0, '1');
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionCase6 = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  checkRelativePositions(ytext);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionAssociationDifference = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, '2');
  ytext.insert(0, '1');
  const rposRight = createRelativePositionFromTypeIndex(ytext, 1, 0);
  const rposLeft = createRelativePositionFromTypeIndex(ytext, 1, -1);
  ytext.insert(1, 'x');
  const posRight = createAbsolutePositionFromRelativePosition(rposRight, ydoc);
  const posLeft = createAbsolutePositionFromRelativePosition(rposLeft, ydoc);
  t__namespace.assert(posRight != null && posRight.index === 2);
  t__namespace.assert(posLeft != null && posLeft.index === 1);
};

/**
 * @param {t.TestCase} tc
 */
const testRelativePositionWithUndo = tc => {
  const ydoc = new Doc();
  const ytext = ydoc.getText();
  ytext.insert(0, 'hello world');
  const rpos = createRelativePositionFromTypeIndex(ytext, 1);
  const um = new UndoManager(ytext);
  ytext.delete(0, 6);
  t__namespace.assert(createAbsolutePositionFromRelativePosition(rpos, ydoc)?.index === 0);
  um.undo();
  t__namespace.assert(createAbsolutePositionFromRelativePosition(rpos, ydoc)?.index === 1);
  const posWithoutFollow = createAbsolutePositionFromRelativePosition(rpos, ydoc, false);
  console.log({ posWithoutFollow });
  t__namespace.assert(createAbsolutePositionFromRelativePosition(rpos, ydoc, false)?.index === 6);
  const ydocClone = new Doc();
  applyUpdate(ydocClone, encodeStateAsUpdate(ydoc));
  t__namespace.assert(createAbsolutePositionFromRelativePosition(rpos, ydocClone)?.index === 6);
  t__namespace.assert(createAbsolutePositionFromRelativePosition(rpos, ydocClone, false)?.index === 6);
};

var relativePositions = /*#__PURE__*/Object.freeze({
  __proto__: null,
  testRelativePositionAssociationDifference: testRelativePositionAssociationDifference,
  testRelativePositionCase1: testRelativePositionCase1,
  testRelativePositionCase2: testRelativePositionCase2,
  testRelativePositionCase3: testRelativePositionCase3,
  testRelativePositionCase4: testRelativePositionCase4,
  testRelativePositionCase5: testRelativePositionCase5,
  testRelativePositionCase6: testRelativePositionCase6,
  testRelativePositionWithUndo: testRelativePositionWithUndo
});

/* eslint-env node */


if (environment.isBrowser) {
  logging__namespace.createVConsole(document.body);
}
t.runTests({
  doc, map, array, text, xml, encoding, undoredo, compatibility, snapshot, updates, relativePositions
}).then(success => {
  /* istanbul ignore next */
  if (environment.isNode) {
    process.exit(success ? 0 : 1);
  }
});
//# sourceMappingURL=tests.cjs.map
