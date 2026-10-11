const path = require("path");
const os = require("os");
process.env.FIRST_ALERT_STATE_FILE = path.join(os.tmpdir(), `first-alert-${process.pid}-${Date.now()}.json`);

const { setLastPublished, getLastPublished, getActiveEvents } = require('../src/messaging/processor');

describe('Processor State Management', () => {
    beforeEach(() => {
        setLastPublished(null, null, null);
        for (const key of Object.keys(getActiveEvents())) delete getActiveEvents()[key];
    });

    it('should correctly set and get the last published event', () => {
        setLastPublished('לבנון', 'חיפה, קריות', '14:30');
        const lastPub = getLastPublished();
        expect(lastPub).toBeDefined();
        expect(lastPub.source).toBe('לבנון');
        expect(lastPub.target).toBe('חיפה, קריות');
        expect(lastPub.estimated_time).toBe('14:30');
        expect(lastPub.publishedAt).toBeLessThanOrEqual(Date.now());
    });

    it('should clear the last published event when passing null values', () => {
        setLastPublished('עזה', 'שדרות', '12:00');
        setLastPublished(null, null, null);
        expect(getLastPublished()).toBeNull();
    });

    it('should return an empty object for active events initially', () => {
        expect(getActiveEvents()).toEqual({});
    });
});
