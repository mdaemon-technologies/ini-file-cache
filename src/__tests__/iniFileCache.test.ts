import * as fs from 'fs';
import * as path from 'path';
import IniFileCache from '../iniFileCache';

jest.mock('fs');
jest.mock('path');
jest.mock('@mdaemon/emitter', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    })),
  };
});

describe('IniFileCache', () => {
  let iniFileCache: IniFileCache;
  const mockCachePath = '/mock/cache/path';
  const mockFileName = 'test.ini';

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    iniFileCache = new IniFileCache(mockCachePath, mockFileName);
  });

  test('constructor creates cache directory if it doesn\'t exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
    new IniFileCache(mockCachePath, mockFileName);
    expect(fs.mkdirSync).toHaveBeenCalledWith(mockCachePath, { recursive: true });
  });

  test('constructor creates file if it doesn\'t exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValueOnce(true).mockReturnValueOnce(false);
    new IniFileCache(mockCachePath, mockFileName);
    expect(fs.writeFileSync).toHaveBeenCalledWith(path.join(mockCachePath, mockFileName), '');
  });

  test('parseContents correctly parses ini content', () => {
    const mockContent = `
      [Section1]
      key1=value1
      key2=value2

      [Section2]
      key3=value3
    `;
    iniFileCache.parseContents(mockContent);
    expect(iniFileCache['settings']).toEqual([
      { name: 'Section1', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] },
      { name: 'Section2', settings: [{ key: 'key3', value: 'value3' }] }
    ]);
  });

  test('getSetting returns correct value', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'testKey', value: 'testValue' }] }
    ];
    expect(iniFileCache.getSetting('TestSection', 'testKey')).toBe('testValue');
  });

  test('getSetting returns default value when key not found', () => {
    expect(iniFileCache.getSetting('NonexistentSection', 'nonexistentKey', 'defaultValue')).toBe('defaultValue');
  });

  test('getBool returns true for truthy values', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [
        { key: 'key1', value: 't' },
        { key: 'key2', value: 'T' },
        { key: 'key3', value: '1' },
        { key: 'key4', value: 'y' },
        { key: 'key5', value: 'Y' },
        { key: 'key6', value: 'true' },
        { key: 'key7', value: 'yes' }
      ]}
    ];
    expect(iniFileCache.getBool('TestSection', 'key1')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key2')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key3')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key4')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key5')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key6')).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'key7')).toBe(true);
  });

  test('getBool returns false for falsy values', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [
        { key: 'key1', value: 'f' },
        { key: 'key2', value: '0' },
        { key: 'key3', value: 'n' },
        { key: 'key4', value: 'false' },
        { key: 'key5', value: 'no' }
      ]}
    ];
    expect(iniFileCache.getBool('TestSection', 'key1')).toBe(false);
    expect(iniFileCache.getBool('TestSection', 'key2')).toBe(false);
    expect(iniFileCache.getBool('TestSection', 'key3')).toBe(false);
    expect(iniFileCache.getBool('TestSection', 'key4')).toBe(false);
    expect(iniFileCache.getBool('TestSection', 'key5')).toBe(false);
  });

  test('getBool returns default value when key not found', () => {
    expect(iniFileCache.getBool('NonexistentSection', 'nonexistentKey', true)).toBe(true);
    expect(iniFileCache.getBool('NonexistentSection', 'nonexistentKey', false)).toBe(false);
    expect(iniFileCache.getBool('NonexistentSection', 'nonexistentKey')).toBe(false);
  });

  test('getBool returns default value when value is empty', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'emptyKey', value: '' }] }
    ];
    expect(iniFileCache.getBool('TestSection', 'emptyKey', true)).toBe(true);
    expect(iniFileCache.getBool('TestSection', 'emptyKey', false)).toBe(false);
  });

  test('getInt returns correct integer value', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [
        { key: 'key1', value: '42' },
        { key: 'key2', value: '0' },
        { key: 'key3', value: '-10' },
        { key: 'key4', value: '999' }
      ]}
    ];
    expect(iniFileCache.getInt('TestSection', 'key1')).toBe(42);
    expect(iniFileCache.getInt('TestSection', 'key2')).toBe(0);
    expect(iniFileCache.getInt('TestSection', 'key3')).toBe(-10);
    expect(iniFileCache.getInt('TestSection', 'key4')).toBe(999);
  });

  test('getInt returns default value when key not found', () => {
    expect(iniFileCache.getInt('NonexistentSection', 'nonexistentKey', 100)).toBe(100);
    expect(iniFileCache.getInt('NonexistentSection', 'nonexistentKey')).toBe(0);
  });

  test('getInt returns default value when value is empty', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'emptyKey', value: '' }] }
    ];
    expect(iniFileCache.getInt('TestSection', 'emptyKey', 50)).toBe(50);
    expect(iniFileCache.getInt('TestSection', 'emptyKey')).toBe(0);
  });

  test('getInt returns default value when value is not a number', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [
        { key: 'key1', value: 'notANumber' },
        { key: 'key2', value: 'abc123' },
        { key: 'key3', value: '12.34' }
      ]}
    ];
    expect(iniFileCache.getInt('TestSection', 'key1', 25)).toBe(25);
    expect(iniFileCache.getInt('TestSection', 'key2', 30)).toBe(30);
    expect(iniFileCache.getInt('TestSection', 'key3')).toBe(12); // parseInt truncates decimals
  });

  test('setSetting adds new section and key', () => {
    iniFileCache.setSetting('NewSection', 'newKey', 'newValue');
    expect(iniFileCache['settings']).toContainEqual({
      name: 'NewSection',
      settings: [{ key: 'newKey', value: 'newValue' }]
    });
  });

  test('save writes settings to file', async () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [{ key: 'key1', value: 'value1' }] }
    ];
    await iniFileCache.save();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(mockCachePath, mockFileName),
      '[Section1]\nkey1=value1\n\n', {"flush": true}
    );
  });

  test('watch calls cacheFileSettings on file change', () => {
    const mockWatch = jest.fn().mockImplementation((file, callback) => {
      callback('change', 'test.ini');
    });
    jest.spyOn(fs, 'watch').mockImplementation(mockWatch);
    
    const spyCacheFileSettings = jest.spyOn(iniFileCache, 'cacheFileSettings');
    iniFileCache.watch();
    
    expect(spyCacheFileSettings).toHaveBeenCalled();
  });

  test('getSections returns all section names', () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [] },
      { name: 'Section2', settings: [] }
    ];
    expect(iniFileCache.getSections()).toEqual(['Section1', 'Section2']);
  });

  test('getKeys returns all keys in a section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] }
    ];
    expect(iniFileCache.getKeys('TestSection')).toEqual(['key1', 'key2']);
  });

  test('hasSection returns true if section exists', () => {
    iniFileCache['settings'] = [{ name: 'TestSection', settings: [] }];
    expect(iniFileCache.hasSection('TestSection')).toBe(true);
    expect(iniFileCache.hasSection('NonexistentSection')).toBe(false);
  });

  test('hasKey returns true if key exists in section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'testKey', value: 'testValue' }] }
    ];
    expect(iniFileCache.hasKey('TestSection', 'testKey')).toBe(true);
    expect(iniFileCache.hasKey('TestSection', 'nonexistentKey')).toBe(false);
  });

  test('removeSection removes the specified section', () => {
    iniFileCache['settings'] = [
      { name: 'Section1', settings: [] },
      { name: 'Section2', settings: [] }
    ];
    iniFileCache.removeSection('Section1');
    expect(iniFileCache['settings']).toEqual([{ name: 'Section2', settings: [] }]);
  });

  test('removeKey removes the specified key from a section', () => {
    iniFileCache['settings'] = [
      { name: 'TestSection', settings: [{ key: 'key1', value: 'value1' }, { key: 'key2', value: 'value2' }] }
    ];
    iniFileCache.removeKey('TestSection', 'key1');
    expect(iniFileCache['settings']).toEqual([
      { name: 'TestSection', settings: [{ key: 'key2', value: 'value2' }] }
    ]);
  });

  test('reload calls cacheFileSettings and emits reload event', async () => {
    const spyCacheFileSettings = jest.spyOn(iniFileCache, 'cacheFileSettings');
    const spyEmit = jest.spyOn(iniFileCache.listener, 'emit');
    await iniFileCache.reload();
    expect(spyCacheFileSettings).toHaveBeenCalled();
    expect(spyEmit).toHaveBeenCalledWith('reload', iniFileCache['file']);
  });

  test('unwatch stops watching the file', () => {
    const mockUnwatchFile = jest.spyOn(fs, 'unwatchFile').mockImplementation(() => {});
    iniFileCache['watching'] = {}; // Mock watching object
    iniFileCache.unwatch();
    expect(mockUnwatchFile).toHaveBeenCalledWith(iniFileCache['file']);
    expect(iniFileCache['watching']).toBeNull();
  });
});