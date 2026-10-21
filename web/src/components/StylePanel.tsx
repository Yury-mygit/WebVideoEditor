import { DEFAULT_STYLE, type HorizontalAlign, type SubtitleStyle, type VerticalPosition } from '@wve/shared';
import type { UpdateProject } from '../editor';

interface Props {
  style: SubtitleStyle;
  update: UpdateProject;
}

const FONTS = ['Arial', 'Verdana', 'Tahoma', 'Segoe UI', 'Calibri', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Courier New', 'Impact'];

export function StylePanel({ style, update }: Props) {
  const set = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) =>
    update((p) => ({ ...p, style: { ...p.style, [key]: value } }), `style-${key}`);

  const num = (key: keyof SubtitleStyle, label: string, min: number, max: number, step = 1) => (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={style[key] as number}
          onChange={(e) => set(key, Number(e.target.value) as never)}
        />
        <input
          type="number"
          className="num"
          min={min}
          max={max}
          step={step}
          value={style[key] as number}
          onChange={(e) => e.target.value !== '' && set(key, Number(e.target.value) as never)}
        />
      </div>
    </label>
  );

  const color = (key: keyof SubtitleStyle, label: string) => (
    <label className="field inline">
      <span>{label}</span>
      <input type="color" value={style[key] as string} onChange={(e) => set(key, e.target.value as never)} />
    </label>
  );

  return (
    <div className="panel style-panel">
      <div className="panel-title">
        Стиль субтитров
        <button
          className="small"
          title="Вернуть стиль по умолчанию"
          onClick={() => update((p) => ({ ...p, style: { ...DEFAULT_STYLE } }))}
        >
          Сброс
        </button>
      </div>

      <label className="field">
        <span>Шрифт</span>
        <input list="font-list" value={style.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} />
        <datalist id="font-list">
          {FONTS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      {num('fontSize', 'Размер, px', 12, 200)}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={style.bold} onChange={(e) => set('bold', e.target.checked)} /> Жирный
        </label>
        <label className="check">
          <input type="checkbox" checked={style.italic} onChange={(e) => set('italic', e.target.checked)} /> Курсив
        </label>
      </div>
      {color('color', 'Цвет текста')}

      <fieldset>
        <legend>
          <label className="check">
            <input type="checkbox" checked={style.boxEnabled} onChange={(e) => set('boxEnabled', e.target.checked)} />{' '}
            Подложка вместо обводки
          </label>
        </legend>
        {style.boxEnabled ? (
          <>
            {color('boxColor', 'Цвет подложки')}
            {num('boxOpacity', 'Непрозрачность', 0, 1, 0.05)}
            {num('boxPadding', 'Поля подложки, px', 0, 60)}
          </>
        ) : (
          <>
            {num('outlineWidth', 'Обводка, px', 0, 12, 0.5)}
            {color('outlineColor', 'Цвет обводки')}
            {num('shadow', 'Тень, px', 0, 12, 0.5)}
            {color('shadowColor', 'Цвет тени')}
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Расположение</legend>
        <div className="row">
          <select value={style.position} onChange={(e) => set('position', e.target.value as VerticalPosition)}>
            <option value="bottom">Внизу</option>
            <option value="middle">По центру</option>
            <option value="top">Вверху</option>
          </select>
          <select value={style.align} onChange={(e) => set('align', e.target.value as HorizontalAlign)}>
            <option value="left">Влево</option>
            <option value="center">По центру</option>
            <option value="right">Вправо</option>
          </select>
        </div>
        {num('marginV', 'Отступ от края, px', 0, 400)}
        {num('maxWidthPct', 'Макс. ширина, %', 20, 100)}
      </fieldset>
    </div>
  );
}
