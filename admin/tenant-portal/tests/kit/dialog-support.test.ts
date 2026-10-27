import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StackPanel } from '@pragmatic-tech-ai/mural/basic'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { DialogButtons } from '../../src/kit/dialog-support.js'

describe('DialogButtons', () =>
{
    it('finds the nested button bound to the command, else undefined', () =>
    {
        const wanted = new RelayCommand(() => undefined)
        const other = new RelayCommand(() => undefined)
        const a = new Button()
        a.Command = other
        const b = new Button()
        b.Command = wanted
        const inner = new StackPanel()
        inner.AddChild(b)
        const root = new StackPanel()
        root.AddChild(a)
        root.AddChild(inner)
        assert.equal(DialogButtons.FindByCommand(root, wanted), b)
        assert.equal(DialogButtons.FindByCommand(root, new RelayCommand(() => undefined)), undefined)
    })
})
