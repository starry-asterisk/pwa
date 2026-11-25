using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;

namespace MoaCapture;

internal sealed class CaptureChoiceWindow<T> : Window where T : class
{
    public T? Choice { get; private set; }

    public CaptureChoiceWindow(string heading, string? details, IReadOnlyList<T> choices, string action)
    {
        Title = Brand.Name;
        Icon = Brand.Image;
        Width = 450;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var content = new StackPanel { Margin = new Thickness(22) };
        Content = content;
        content.Children.Add(Theme.Label(heading, 20, true));
        if (details is not null)
        {
            var description = Theme.Label(details);
            description.Margin = new Thickness(0, 8, 0, 0);
            content.Children.Add(description);
        }
        var list = new ListBox
        {
            ItemsSource = choices, MinHeight = 68, MaxHeight = 250, Margin = new Thickness(0, 14, 0, 14),
            Padding = new Thickness(5), SelectedIndex = 0, FontSize = 15
        };
        AutomationProperties.SetName(list, heading);
        ScrollViewer.SetHorizontalScrollBarVisibility(list, ScrollBarVisibility.Disabled);
        content.Children.Add(list);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal };
        content.Children.Add(buttons);
        var accept = Theme.Button(action, true);
        accept.IsDefault = true;
        accept.IsEnabled = choices.Count > 0;
        accept.Click += (_, _) => Choose(list);
        list.MouseDoubleClick += (_, args) =>
        {
            if (ItemsControl.ContainerFromElement(list, (DependencyObject)args.OriginalSource) is ListBoxItem)
                Choose(list);
        };
        list.SelectionChanged += (_, _) => accept.IsEnabled = list.SelectedItem is T;
        buttons.Children.Add(accept);
        var cancel = Theme.Button("취소");
        cancel.IsCancel = true;
        buttons.Children.Add(cancel);
        Loaded += (_, _) => Keyboard.Focus(list);
    }

    private void Choose(ListBox list)
    {
        if (list.SelectedItem is T choice)
        {
            Choice = choice;
            DialogResult = true;
        }
    }
}
